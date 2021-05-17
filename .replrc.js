var { client, xml } = require('@xmpp/client');

const XMPP_ANONYMOUS_SALT = 'salt';
var ethers = require('ethers');
var debug = require('@xmpp/debug');

var toPassword = (phone) => ethers.utils.solidityKeccak256(['string', 'string'], [ XMPP_ANONYMOUS_SALT, phone ]);

var xmpp = client({
  service: 'xmpp://127.0.0.1:5222',
  domain: 'localhost',
  username: '757636201',
  password: toPassword('7576362081')
});

var getRegistrationDetails = async (xmpp) => {
  await xmpp.connect(xmpp.options.service);
  await xmpp.send(xml('query', { xmlns: 'jabber:iq:register' }));
};


var register = async (xmpp, username) => {
  await xmpp.connect(xmpp.options.service);
  await xmpp.send(xml('iq', { type: 'set', id: 'reg2' }, xml('query', { xmlns: 'jabber:iq:register' }, xml('username', {}, username) + xml('password', {}, toPassword(username)) + xml('email', {}, username + '@stomp.dynv6.net'))));
  await xmpp.disconnect();
};

debug(xmpp, true);

