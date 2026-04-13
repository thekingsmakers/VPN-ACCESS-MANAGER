const ActiveDirectory = require('activedirectory2');
const ldap = require('ldapjs');
const Setting = require('../models/Setting');
const { decryptStr } = require('../utils/crypto');

// Mock implementation for MVP out-of-box working without real AD
const USE_MOCK = process.env.NODE_ENV === 'development' && !process.env.AD_PASSWORD;

const getAdInstance = async () => {
  if (USE_MOCK) return null;
  const settings = await Setting.findOne();
  if (!settings?.activeDirectory?.url) throw new Error("AD Configuration missing from encrypted database arrays.");
  
  const decryptedPassword = decryptStr(settings.activeDirectory.encryptedPassword);
  
  const config = {
    url: settings.activeDirectory.url,
    baseDN: settings.activeDirectory.baseDn,
    username: settings.activeDirectory.username,
    password: decryptedPassword,
    attributes: {
      user: ['dn', 'sAMAccountName', 'mail', 'manager', 'displayName'],
      group: ['dn', 'cn', 'description']
    }
  };
  return new ActiveDirectory(config);
};

const getDirectLdapClient = async () => {
   if (USE_MOCK) return null;
   const settings = await Setting.findOne();
   if (!settings?.activeDirectory?.url) throw new Error("AD Configuration missing.");
   const decryptedPassword = decryptStr(settings.activeDirectory.encryptedPassword);
   
   const client = ldap.createClient({ url: settings.activeDirectory.url });
   return new Promise((resolve, reject) => {
     client.bind(settings.activeDirectory.username, decryptedPassword, (err) => {
       if (err) {
         client.unbind();
         return reject(err);
       }
       resolve(client);
     });
   });
};

// Improved Utility to execute AD methods with timeout safely
const callAdMethod = (methodName, ...args) => {
  return new Promise((resolve, reject) => {
    getAdInstance().then(ad => {
      if (!ad) {
        return reject(new Error("Active Directory instance not available (Mock mode or config error)"));
      }

      if (typeof ad[methodName] !== 'function') {
        return reject(new Error(`LDAP method "${methodName}" is not supported by the current AD client.`));
      }

      const timeoutMs = 10000;
      const timer = setTimeout(() => {
        reject(new Error(`LDAP operation "${methodName}" timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      try {
        ad[methodName](...args, (err, data) => {
          clearTimeout(timer);
          if (err) return reject(err);
          resolve(data);
        });
      } catch (err) {
        clearTimeout(timer);
        reject(err);
      }
    }).catch(reject);
  });
};

const authenticate = (username, password) => {
  return new Promise((resolve, reject) => {
    if (USE_MOCK) {
      if (password === 'password') {
        const role = username.toLowerCase().includes('admin') ? 'super_admin' : username.toLowerCase().includes('security') ? 'it_admin' : username.toLowerCase().includes('mgr') ? 'manager' : 'user';
        return resolve({
          sAMAccountName: username,
          mail: `${username}@mockdomain.com`,
          displayName: `Mock ${username}`,
          manager: `CN=Mock Manager,${process.env.AD_BASE_DN}`,
          role
        });
      }
      return reject(new Error('Invalid credentials'));
    }

    callAdMethod('authenticate', username, password).then(async auth => {
      if (auth) {
        try {
          const user = await callAdMethod('findUser', username);
          if (!user) return reject(new Error('User not found after auth'));
          
          const groups = await callAdMethod('getGroupMembershipForUser', user.dn);
          let role = 'user';
          
          let settings = await Setting.findOne();
          const adMapping = settings?.adMapping || {
            itAdminGroup: 'ITADMINTEAM',
            itSecurityGroup: 'ITSECURITYTEAM',
            defaultVpnGroup: process.env.VPN_AD_GROUP || 'VPN_USERS'
          };
          
          if (groups) {
            const groupCNs = groups.map(g => (g.cn || '').toUpperCase());
            const groupDNs = groups.map(g => (g.dn || '').toUpperCase());
            const adminTarget = adMapping.itAdminGroup.toUpperCase();
            const secTarget = adMapping.itSecurityGroup.toUpperCase();

            if (groupCNs.includes(adminTarget) || groupDNs.includes(adminTarget)) {
              role = 'super_admin';
            } else if (groupCNs.includes(secTarget) || groupDNs.includes(secTarget)) {
              role = 'it_admin';
            }
          }
          
          const lowerUser = username.toLowerCase();
          if (role === 'user') {
            if (lowerUser.includes('manager')) role = 'manager';
            else if (lowerUser.includes('itadmin')) role = 'super_admin';
            else if (lowerUser.includes('itsecurity')) role = 'it_admin';
          }
          
          user.role = role;
          resolve(user);
        } catch (err) {
          reject(err);
        }
      } else {
        reject(new Error('Authentication failed'));
      }
    }).catch(reject);
  });
};

const getManagerDetails = (managerDn) => {
  return new Promise((resolve, reject) => {
    if (USE_MOCK) return resolve({ sAMAccountName: 'mgr1', mail: 'mgr1@mockdomain.com' });
    callAdMethod('findUser', managerDn).then(resolve).catch(reject);
  });
};

const addUserToGroup = (username, groupName) => {
  return new Promise((resolve, reject) => {
    if (USE_MOCK) {
      console.log(`[MOCK LDAP] Added ${username} to group ${groupName}`);
      return resolve(true);
    }
    
    getAdInstance().then(async ad => {
      try {
        const user = await callAdMethod('findUser', username);
        if (!user) return reject(new Error(`Failed to locate AD user: ${username}`));
        
        const group = await callAdMethod('findGroup', groupName);
        if (!group) return reject(new Error(`Failed to locate AD target group: ${groupName}`));
        
        const client = await getDirectLdapClient();
        const change = new ldap.Change({
          operation: 'add',
          modification: { member: [user.dn] }
        });

        await new Promise((res, rej) => {
          const t = setTimeout(() => rej(new Error('LDAP Modify timed out')), 10000);
          client.modify(group.dn, change, (err) => {
            clearTimeout(t);
            client.unbind();
            if (err) {
              if (err.name === 'EntryAlreadyExistsError' || err.name === 'TypeOrValueExistsError' || (err.message && err.message.includes('exists'))) {
                return res(true);
              }
              return rej(err);
            }
            res(true);
          });
        });
        resolve(true);
      } catch (err) {
        reject(err);
      }
    }).catch(reject);
  });
};

const removeUserFromGroup = (username, groupName) => {
  return new Promise((resolve, reject) => {
    if (USE_MOCK) {
       console.log(`[MOCK LDAP] Removed ${username} from group ${groupName}`);
       return resolve(true);
    }

    getAdInstance().then(async ad => {
      try {
        const user = await callAdMethod('findUser', username);
        if (!user) return reject(new Error(`Failed to locate AD user: ${username}`));
        
        const group = await callAdMethod('findGroup', groupName);
        if (!group) return reject(new Error(`Failed to locate AD target group: ${groupName}`));
        
        const client = await getDirectLdapClient();
        const change = new ldap.Change({
          operation: 'delete',
          modification: { member: [user.dn] }
        });

        await new Promise((res, rej) => {
          const t = setTimeout(() => rej(new Error('LDAP Delete timed out')), 10000);
          client.modify(group.dn, change, (err) => {
            clearTimeout(t);
            client.unbind();
            if (err) {
              if (err.name === 'NoSuchAttributeError') return res(true);
              return rej(err);
            }
            res(true);
          });
        });
        resolve(true);
      } catch (err) {
        reject(err);
      }
    }).catch(reject);
  });
};

const getGroupMembers = (groupName) => {
  return new Promise((resolve, reject) => {
    if (USE_MOCK) {
      if (process.env.MOCK_AD_MEMBERS === 'skip') return resolve(null);
      console.log(`[MOCK LDAP] getGroupMembers(${groupName}) → []`);
      return resolve([]);
    }

    getAdInstance().then(async ad => {
      try {
        const group = await callAdMethod('findGroup', groupName);
        if (!group) {
          console.warn(`[LDAP] Group "${groupName}" NOT FOUND in AD.`);
          return resolve(null); 
        }

        const users = await callAdMethod('getUsersForGroup', groupName);
        if (!users) return resolve([]);

        const names = users.map(u => (u.sAMAccountName || '').toLowerCase()).filter(Boolean);
        resolve(names);
      } catch (err) {
        console.error(`[LDAP] getGroupMembers error:`, err.message);
        resolve(null);
      }
    }).catch(err => {
      console.error(`[LDAP] getGroupMembers connectivity error:`, err.message);
      resolve(null);
    });
  });
};

const findUserDetails = (username) => {
  return new Promise((resolve, reject) => {
    if (USE_MOCK) {
      return resolve({
        sAMAccountName: username,
        mail: `${username}@mockdomain.com`,
        displayName: `Mock ${username}`,
        dn: `CN=${username},CN=Users,${process.env.AD_BASE_DN}`
      });
    }

    callAdMethod('findUser', username).then(resolve).catch(reject);
  });
};

module.exports = {
  authenticate,
  getManagerDetails,
  addUserToGroup,
  removeUserFromGroup,
  getGroupMembers,
  findUserDetails
};
