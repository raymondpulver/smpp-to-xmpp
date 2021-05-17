'use strict';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = 0;
const child_process = require('child_process');
const url = require('url');
const path = require('path');
const SMPP_URL = process.env.SMPP_URL || 'ssmpp://smpp.voip.ms:3550';
const SMPP_SYSTEM_ID = process.env.SMPP_SYSTEM_ID;
const SMPP_PASSWORD = process.env.SMPP_PASSWORD;
const SMPP_TLSKEY = process.env.SMPP_TLSKEY || null;
const SMPP_TLSCERT = process.env.SMPP_TLSCERT || null;
const XMPP_SERVER = process.env.XMPP_HOST || 'xmpp://127.0.0.1:5222';
const XMPP_DOMAIN = process.env.XMPP_DOMAIN || 'localhost';
const XMPP_ANONYMOUS_SALT = process.env.XMPP_ANONYMOUS_SALT || 'salt';
const PROSODY_ACCOUNTS_DIRECTORY = process.env.PROSODY_ACCOUNTS_DIRECTORY || '/var/lib/prosody/' + XMPP_DOMAIN.replace(/\./g, '%2e') + '/accounts';;
const { client, xml } = require('@xmpp/client');
const smpp = require('smpp');
const ethers = require('ethers');
const fs = require('fs-extra');
const debug = require('@xmpp/debug');

const toPassword = (phone) => ethers.utils.solidityKeccak256(['string', 'string'], [ XMPP_ANONYMOUS_SALT, phone ]);

const createXMPPUser = (number) => new Promise(async (resolve, reject) => {
  const proc = child_process.spawn('prosodyctl', [ 'adduser' , number + '@' + XMPP_DOMAIN ]);
  proc.on('exit', resolve);
  proc.on('error', reject);
  proc.stdout.pipe(process.stdout);
  proc.stderr.pipe(process.stderr);
  await new Promise((resolve, reject) => {
    setTimeout(resolve, 5);
  });
  const password = toPassword(number);
  proc.stdin.write(password + '\n');
  await new Promise((resolve, reject) => {
    setTimeout(resolve, 5);
  });
  proc.stdin.write(password + '\n');
});

const maybeCreateXMPPUser = async (number) => {
  const exists = await fs.exists(path.join(PROSODY_ACCOUNTS_DIRECTORY, number + '.dat'));
  if (!exists) await createXMPPUser(number);
};

const phoneToSession = {};

const initializeThreads = async () => {
  const directory = (await fs.readdir(path.join(PROSODY_ACCOUNTS_DIRECTORY))).filter((v) => !v.match('smsbot'));
  await Promise.all(directory.map(async (v) => {
    const number = v.substr(0, v.length - 4);
    const contents = await fs.readFile(path.join(PROSODY_ACCOUNTS_DIRECTORY, v), 'utf8');
    const password = contents.substr(contents.indexOf('"0x') + 1, 66);
    if (password === toPassword(number)) {
      const xmpp = await startXMPP(number, send);
      phoneToSession[number] = xmpp;
    }
  }));
};

const XMPP_SMSBOT_USER = process.env.XMPP_SMSBOT_USER || 'smsbot';

const startSmsBot = async () => {
  await maybeCreateXMPPUser(XMPP_SMSBOT_USER);
  const xmpp = client({
    service: XMPP_SERVER,
    domain: XMPP_DOMAIN,
    username: XMPP_SMSBOT_USER,
    password: toPassword(XMPP_SMSBOT_USER)
  });
  if (process.env.XMPP_DEBUG) debug(xmpp, true);
  xmpp.on('online', () => xmpp.send(xml('presence')));
  xmpp.on('stanza', async (stanza) => {
    if (stanza.is('message')) {
      if (!stanza.getChild('body')) return;
      const number = stanza.getChildText('body').trim().replace(/[\(\)\-\s]/g, '');
      if (/^[\d]+$/.test(number)) {
        await xmpp.send(xml("message", { type: 'chat', to: stanza.getAttr('from') }, xml('body', {}, String(number) + '@' + XMPP_DOMAIN + ' going on-line!')));
        await maybeCreateXMPPUser(number);
      }
    }
  });
  await xmpp.start();
  return xmpp;
};

    
  

const startXMPP = async (phone, send) => {
  await maybeCreateXMPPUser(phone);
  const xmpp = client({
    service: XMPP_SERVER,
    domain: XMPP_DOMAIN,
    username: phone,
    password: toPassword(phone)
  });
  if (process.env.XMPP_DEBUG) debug(xmpp, true);
  xmpp.on('online', () => xmpp.send(xml('presence')));
  xmpp.on('stanza', async (stanza) => {
    if (stanza.is('message')) {
      if (!stanza.getChild('body')) return;
      const re = /(?:[^@]+|@|.*$)/g;
      const from = stanza.getAttr('from');
      const [ fromNumber, _, urlString ] = from.match(re);
      const parsed = url.parse('https://' + urlString);
      if (parsed.host !== XMPP_DOMAIN) return;
      send({
        from: fromNumber,
	to: phone,
	message: stanza.getChildText('body')
      });
    }
  });
  await xmpp.start();
  xmpp.handle = async (sms) => {
    await xmpp.send(xml("message", { type: 'chat', to: sms.to + '@' + XMPP_DOMAIN }, xml('body', {}, sms.message)));
  };
  return xmpp;
};

const connect = () => smpp.connect({ url: SMPP_URL });

const bind = (session) => new Promise((resolve, reject) => session.bind_transceiver({
  system_id: SMPP_SYSTEM_ID,
  password: SMPP_PASSWORD
}, (pdu) => resolve(pdu)));

const once = (fn) => {
  let done;
  return (...args) => {
    done = true;
    return fn(...args);
  };
};

const send = async ({ from: source_addr, to: destination_addr, message: short_message }) => {
  const session = connect();
  try {
    let pdu = await bind(session);
    if (pdu.command_status !== 0) throw Error('command_status: ' + String(pdu.command_status));
    pdu = await new Promise((resolve) => session.submit_sm({
      destination_addr,
      source_addr,
      short_message
    }, once(resolve)));
    if (pdu.command_status !== 0) throw Error('command_status: ' + String(pdu.command_Status));
    session.close();
    return pdu;
  } catch (e) { console.error(e); session.close(); }
};

const checkUserPass = (pdu) => {
  return pdu.system_id === SMPP_SYSTEM_ID && pdu.password === SMPP_PASSWORD;
};

const smsFromPdu = (pdu) => {
  const { destination_addr: to, source_addr: from, short_message: { message } } = pdu;
  return {
    from,
    to,
    message
  };
};

const pduHandler = (session, handleSms) => (pdu) => {
  session.send(pdu.response());
  handleSms(smsFromPdu(pdu));
};

const smppHandler = (handleSms) => (session) => {
  session.on('bind_transceiver', (pdu) => {
    if (!checkUserPass(pdu)) {
      session.send(pdu.response({
        command_status: smpp.ESME_RBINDFAIL
      }));
      session.close();
      return;
    }
    session.on('deliver_sm', pduHandler(session, handleSms));
    session.on('submit_sm', pduHandler(session, handleSms));
    session.on('enquire_link', (pdu) => session.send(pdu.response()));
    session.send(pdu.response());
  });
};

const startSecureSMPPServer = (handleSms) => {
  const server = smpp.createServer({
    cert: SMPP_TLSCERT,
    key: SMPP_TLSKEY
  }, smppHandler(handleSms));
  server.listen(3550, '0.0.0.0');
  return server;
};

const startSMPPServer = (handleSms) => {
  const server = smpp.createServer(smppHandler(handleSms));
  server.listen(2775, '0.0.0.0');
  return server;
};


const handleSms = async (sms) => {
  try {
    if (!phoneToSession[sms.from]) phoneToSession[sms.from] = await startXMPP(sms.from, send);
    const xmpp = phoneToSession[sms.from];
    await xmpp.handle(sms);
  } catch (e) { console.error(e); }
};

(async () => {
  await initializeThreads();
  await startSmsBot();
  if (SMPP_TLSKEY && SMPP_TLSCERT) return startSecureSMPPServer(handleSms);
  else return startSMPPServer(handleSms);
})().catch((err) => console.error(err));
