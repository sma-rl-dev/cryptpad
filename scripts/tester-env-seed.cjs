// SPDX-FileCopyrightText: 2026 XWiki CryptPad Team <contact@cryptpad.org> and contributors
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// tester-env deterministic seed for CryptPad.
//
// Strategy: scripted fixed test account (option (a) in the seed-engineer brief).
// CryptPad accounts are E2E-encrypted: scrypt-derived keys live in the browser,
// there is no server seed API. This script reproduces the browser registration
// flow headlessly from inside the container (localhost network):
//   1. scrypt-derive fixed account keys for rl-tester (deterministic),
//   2. WRITE_BLOCK login block via /api/auth signed handshake (deterministic block keys),
//   3. create 3 pad channels (deterministic 18-byte seeds -> channels + edit hrefs)
//      with fixed initial content via websocket Listmap,
//   4. create the account drive channel with identity + drive user-object
//      (folder Notes, 3 files with fixed ids/titles/ctime/atime).
// All randomness is replaced by SHA256('cryptpad-seed/v1/'+label) derivations,
// so reset -> deploy -> seed reproduces identical channels, hrefs and content.
// The script is idempotent: if the account channel is already populated it exits 3.
//
// Usage (inside container): node /cryptpad/scripts/tester-env-seed.cjs
// The tester-env CLI copies this file in and runs it via `docker exec`, passing
// CPAD_MAIN_PORT (allocated run port). The seed talks to the container's own
// loopback, not to the browser-visible origin: host.docker.internal is not
// resolvable inside the app container. Channel ids do not depend on the port.
//
// Read-back (for interactive debugging, not part of seed):
//   node /cryptpad/scripts/tester-env-seed.cjs --verify
'use strict';

const MAIN_PORT = process.env.CPAD_MAIN_PORT || '8240';
const SEED_ORIGIN = process.env.CPAD_SEED_ORIGIN || ('http://localhost:' + MAIN_PORT);

globalThis.window = globalThis;
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};
globalThis.location = { hostname: 'localhost', href: SEED_ORIGIN + '/' };
globalThis.atob = (s) => Buffer.from(s, 'base64').toString('binary');
globalThis.btoa = (s) => Buffer.from(s, 'binary').toString('base64');

const Util = require('/cryptpad/src/common/common-util.js');
const Nacl = require('/cryptpad/node_modules/tweetnacl/nacl-fast.js');
globalThis.nacl = Nacl;
globalThis.WebSocket = require('/cryptpad/node_modules/ws');
const Crypto = require('/cryptpad/node_modules/chainpad-crypto/crypto.js');
const Hash = require('/cryptpad/src/common/common-hash.js');
const Cred = require('/cryptpad/src/common/common-credential.js');
const Block = require('/cryptpad/src/common/outer/login-block.js');
const ServerCommand = require('/cryptpad/src/common/outer/http-command.js');
const ChainPad = require('/cryptpad/node_modules/chainpad/chainpad.dist.js');
const Listmap = require('/cryptpad/node_modules/chainpad-listmap/chainpad-listmap.js');
globalThis.ChainPad = ChainPad;
ServerCommand.setCustomize({ ApiConfig: { httpUnsafeOrigin: SEED_ORIGIN } });

const SEED_NS = 'cryptpad-seed/v1/';
const UNAME = 'rl-tester';
const PASSWD = 'Test-Password-RL-2026-Seed!';
const WS_URL = 'ws://localhost:' + MAIN_PORT + '/cryptpad_websocket';
const FIXED_CTIME = 1777626000000; // 2026-05-01T09:00:00Z fixed, assertion-stable

const detSeed = (label) => Nacl.hash(Util.decodeUTF8(SEED_NS + label)).subarray(0, 18);
const b64ToHex = (b64) => Buffer.from(b64.replace(/-/g, '/'), 'base64').toString('hex');

// Seed contents: 3 code-app docs + 1 folder.
// code-type channels render seeded plain-string content verbatim; 'pad'
// (Rich Text) requires structured content and script-errors on plain strings.
// Titles/contents are fixed strings for browser assertions.
const PADS = [
    {
        name: 'Q2 Launch Plan',
        type: 'code',
        content: 'Q2 Launch Plan\n\nGoals: ship v2, onboard 5 beta users.\nOwner: rl-tester.\n',
    },
    {
        name: 'Team Standup Notes',
        type: 'code',
        content: '# Standup 2026-05-01\n\n- Alice: API done\n- Bob: UI review\n- Carol: docs\n',
    },
    {
        name: 'Shared Links',
        type: 'code',
        content: 'Shared Links\n\nhttps://cryptpad.org\nhttps://docs.cryptpad.org\nOnboarding checklist: request invite, set display name.\n',
    },
];
const FILE_IDS = { 'Q2 Launch Plan': 1000000000001, 'Team Standup Notes': 1000000000002, 'Shared Links': 1000000000003 };

const derivePad = (p) => {
    const keys = Crypto.createEditCryptor2(undefined, detSeed('pad:' + p.name));
    const editHash = Hash.getEditHashFromKeys({ version: 2, type: p.type, keys });
    const viewHash = Hash.getViewHashFromKeys({ version: 2, type: p.type, keys });
    return { ...p, keys, channel: b64ToHex(keys.chanId), href: '/' + p.type + '/#' + editHash, roHref: '/' + p.type + '/#' + viewHash };
};

const openChan = (keys, channel, owners) => Listmap.create({
    data: {}, validateKey: keys.validateKey, crypto: Crypto.createEncryptor(keys),
    ChainPad, channel, owners, classic: true, websocketURL: WS_URL,
});
const waitReady = (rt, label) => new Promise((res, rej) => {
    const to = setTimeout(() => rej(new Error('ready timeout: ' + label)), 60000);
    rt.proxy.on('ready', () => { clearTimeout(to); res(rt); });
    rt.proxy.on('error', (info) => { clearTimeout(to); rej(new Error('rt error ' + label + ': ' + JSON.stringify(info).slice(0, 200))); });
});
const waitSync = (ms) => new Promise((r) => setTimeout(r, ms));
const stopRt = (rt) => { try { rt.stop && rt.stop(); } catch (e) {} };

const deriveAccount = () => new Promise((resolve) => {
    Cred.deriveFromPassphrase(UNAME, PASSWD, 192, (bytes) => {
        // Slice order mirrors allocateBytes() in www/common/common-login.js
        const dispense = Cred.dispenser(bytes);
        dispense(18); // encryption seed (pad keys are derived separately, see below)
        dispense(16); // legacy channel seed (unused for modern accounts)
        const curveSeed = dispense(32);
        const curvePair = Nacl.box.keyPair.fromSecretKey(new Uint8Array(curveSeed));
        const edSeed = dispense(32);
        const blockKeys = Block.genkeys(new Uint8Array(dispense(64)));
        const signing = Nacl.sign.keyPair.fromSeed(new Uint8Array(edSeed));
        resolve({
            curvePublic: Util.encodeBase64(curvePair.publicKey),
            curvePrivate: Util.encodeBase64(curvePair.secretKey),
            edPublic: Util.encodeBase64(signing.publicKey),
            edPrivate: Util.encodeBase64(signing.secretKey),
            blockKeys,
        });
    });
});

const isProxyEmpty = (proxy) => {
    const keys = Object.keys(proxy).filter((k) => k !== '_events' && k !== 'on');
    return keys.length === 0;
};

const cmdSeed = async () => {
    const acct = await deriveAccount();
    const driveKeys = Crypto.createEditCryptor2(undefined, detSeed('drive:rl-tester'));
    const driveChannel = b64ToHex(driveKeys.chanId);
    const userHash = Hash.getEditHashFromKeys({ version: 2, type: 'drive', keys: driveKeys });

    const padInfos = PADS.map(derivePad);

    const acctRt = openChan(driveKeys, driveChannel, [acct.edPublic]);
    await waitReady(acctRt, 'account');
    if (!isProxyEmpty(acctRt.proxy)) {
        console.log('seed: account channel already populated, nothing to do.');
        stopRt(acctRt);
        process.exit(3);
    }

    await new Promise((res, rej) => {
        // Key MUST be 'User_hash' (Constants.userHashKey): the login flow reads
        // block_info[Constants.userHashKey] and falls back to an empty hash
        // (guest drive) when it is absent. Lowercase 'userHash' decrypts fine
        // but is ignored by the browser, causing "Invalid username or password".
        Block.writeLoginBlock({ pw: true, blockKeys: acct.blockKeys, content: { User_hash: userHash, edPublic: acct.edPublic } },
            (e) => (e ? rej(new Error('WRITE_BLOCK: ' + e)) : res()));
    });
    console.log('seed: login block written for ' + UNAME);

    for (const p of padInfos) {
        const rt = openChan(p.keys, p.channel, [acct.edPublic]);
        await waitReady(rt, 'pad:' + p.name);
        if (!rt.proxy.content) { rt.proxy.content = p.content; }
        await waitSync(6000);
        stopRt(rt);
        console.log('seed: pad written: ' + p.name + ' channel=' + p.channel);
    }

    acctRt.proxy.edPublic = acct.edPublic;
    acctRt.proxy.edPrivate = acct.edPrivate;
    acctRt.proxy.curvePublic = acct.curvePublic;
    acctRt.proxy.curvePrivate = acct.curvePrivate;
    acctRt.proxy.login_name = UNAME;
    // Real registration sets BOTH proxy.login_name AND proxy['cryptpad.username']
    // (Constants.displayNameKey); the drive UI reads the latter for the user label.
    acctRt.proxy['cryptpad.username'] = UNAME;
    acctRt.proxy.version = 11;
    acctRt.proxy.drive = {
        root: { 'Q2 Launch Plan': FILE_IDS['Q2 Launch Plan'], Notes: {} },
        template: [],
        trash: {},
        filesData: {
            [FILE_IDS['Q2 Launch Plan']]: { href: padInfos[0].href, roHref: padInfos[0].roHref, channel: padInfos[0].channel, title: 'Q2 Launch Plan', ctime: FIXED_CTIME, atime: FIXED_CTIME, owners: [acct.edPublic] },
            [FILE_IDS['Team Standup Notes']]: { href: padInfos[1].href, roHref: padInfos[1].roHref, channel: padInfos[1].channel, title: 'Team Standup Notes', ctime: FIXED_CTIME + 1000, atime: FIXED_CTIME + 1000 },
            [FILE_IDS['Shared Links']]: { href: padInfos[2].href, roHref: padInfos[2].roHref, channel: padInfos[2].channel, title: 'Shared Links', ctime: FIXED_CTIME + 2000, atime: FIXED_CTIME + 2000 },
        },
    };
    acctRt.proxy.drive.root.Notes['Team Standup Notes'] = FILE_IDS['Team Standup Notes'];
    acctRt.proxy.drive.root.Notes['Shared Links'] = FILE_IDS['Shared Links'];
    await waitSync(8000);
    stopRt(acctRt);
    console.log('seed: drive populated for ' + UNAME + ' (3 docs, folder Notes).');
    console.log('seed: DONE');
};

// Server-observable verification: reopen account + pads fresh and assert fixed state.
const cmdVerify = async () => {
    const failures = [];
    const acct = await deriveAccount();
    const driveKeys = Crypto.createEditCryptor2(undefined, detSeed('drive:rl-tester'));
    const driveChannel = b64ToHex(driveKeys.chanId);
    const rt = openChan(driveKeys, driveChannel, [acct.edPublic]);
    try {
        await waitReady(rt, 'account');
    } catch (e) {
        console.log('[FAIL] account channel not readable: ' + e.message);
        process.exit(1);
    }
    const check = (label, cond, detail) => {
        if (cond) { console.log('  [ok] ' + label); }
        else { console.log('  [FAIL] ' + label + (detail ? ' (' + detail + ')' : '')); failures.push(label); }
    };
    check('account login_name is rl-tester', rt.proxy.login_name === UNAME, String(rt.proxy.login_name));
    check('account edPublic matches fixed derivation', rt.proxy.edPublic === acct.edPublic);
    const drive = rt.proxy.drive || {};
    const filesData = drive.filesData || {};
    const titles = Object.values(filesData).map((f) => f.title).sort();
    check('drive has 3 seeded docs', titles.length === 3, JSON.stringify(titles));
    check('drive titles match', JSON.stringify(titles) === JSON.stringify(['Q2 Launch Plan', 'Shared Links', 'Team Standup Notes']), JSON.stringify(titles));
    check('folder Notes exists with 2 docs', !!(drive.root && drive.root.Notes && drive.root.Notes['Team Standup Notes'] && drive.root.Notes['Shared Links']), JSON.stringify(drive.root));
    check('drive root is 1 doc + Notes folder', JSON.stringify(Object.keys(drive.root || {}).sort()) === JSON.stringify(['Notes', 'Q2 Launch Plan']), JSON.stringify(Object.keys(drive.root || {})));
    check('templates and trash are empty', JSON.stringify(drive.template || []) === '[]' && JSON.stringify(drive.trash || {}) === '{}', JSON.stringify({ template: drive.template, trash: drive.trash }));
    const padInfos = PADS.map(derivePad);
    padInfos.forEach((p, i) => {
        const entry = Object.values(filesData).find((f) => f.channel === p.channel);
        check('drive entry channel matches: ' + p.name, !!entry, 'channel=' + p.channel);
        if (entry) {
            check('drive entry title matches: ' + p.name, entry.title === p.name, String(entry.title));
            check('drive entry creation is fixed: ' + p.name, entry.ctime === FIXED_CTIME + i * 1000, String(entry.ctime));
            check('drive entry read-only link present: ' + p.name, entry.roHref === p.roHref, String(entry.roHref));
        }
    });
    stopRt(rt);
    for (const p of padInfos) {
        const prt = openChan(p.keys, p.channel, [acct.edPublic]);
        try {
            await waitReady(prt, 'pad:' + p.name);
            check('pad content matches: ' + p.name, prt.proxy.content === p.content, JSON.stringify(prt.proxy.content).slice(0, 80));
        } catch (e) {
            check('pad readable: ' + p.name, false, e.message);
        }
        stopRt(prt);
    }
    if (failures.length) { console.log('seed verify FAILED: ' + failures.length + ' check(s)'); process.exit(1); }
    console.log('seed verify: all seed checks passed.');
};

(async () => {
    try {
        if (process.argv.includes('--verify')) { await cmdVerify(); }
        else { await cmdSeed(); }
        setTimeout(() => process.exit(0), 800);
    } catch (e) {
        console.error('seed FATAL: ' + (e && e.message));
        process.exit(1);
    }
})();
