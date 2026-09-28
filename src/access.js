// Mirror the server's rules. Wildcard access also covers networks that did not
// exist when the session loaded, such as a devnet that is being created.
export const canSee = (s, name) => !!(s.allNetworks || s.memberOf?.includes(name));
export const canOperate = (s, name) => !!((s.allNetworks && s.role !== 'viewer') || s.operatorOf?.includes(name));
