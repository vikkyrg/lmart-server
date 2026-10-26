const admin = require('firebase-admin');
console.log('type:', typeof admin);
console.log('keys:', Object.keys(admin).join(', '));
console.log('default?', typeof admin.default);
if (admin.default) console.log('default keys:', Object.keys(admin.default).join(', '));
