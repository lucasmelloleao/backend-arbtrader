const fs = require('fs');
const path = require('path');
const os = require('os');

const sshDir = path.join(os.homedir(), '.ssh');
if (!fs.existsSync(sshDir)) {
  fs.mkdirSync(sshDir, { recursive: true });
}

const privateKey = `-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW
QyNTUxOQAAACCCEN6qsQfjZeLBxTJAHNitOEpQcvO4anJbnpWZ2l8JSwAAAJipec65qXnO
uQAAAAtzc2gtZWQyNTUxOQAAACCCEN6qsQfjZeLBxTJAHNitOEpQcvO4anJbnpWZ2l8JSw
AAAECww0ORfGLzZ+Iv/QMGP9gu5Jc4PJj/xfO3gcMzfnaCq4IQ3qqxB+Nl4sHFMkAc2K04
SlBy87hqcluelZnaXwlLAAAAEmNvYW1vXGxsZWFvQE5DRDEzNwECAw==
-----END OPENSSH PRIVATE KEY-----
`;

const publicKey = `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIIIQ3qqxB+Nl4sHFMkAc2K04SlBy87hqcluelZnaXwlL coamo\\lleao@NCD137
`;

fs.writeFileSync(path.join(sshDir, 'id_ed25519'), privateKey.replace(/\r\n/g, '\n'), { encoding: 'utf8' });
fs.writeFileSync(path.join(sshDir, 'id_ed25519.pub'), publicKey.replace(/\r\n/g, '\n'), { encoding: 'utf8' });

console.log("CHAVES SSH SALVAS COM FORMATO UNIX LF COM SUCESSO EM:", sshDir);
