'use strict';
// Хранение секретов (токенов) в файлах: шифрование средствами ОС, если оно есть, иначе base64 с предупреждением.
// На Windows — DPAPI (Electron safeStorage): расшифровать может только тот же пользователь Windows на этом же компьютере.
//   s1:<base64>  — зашифровано;  p1:<base64>  — просто закодировано (шифрования нет).
// Пользуются accounts.js (токены Ely.by) и friends.js (сессия сервера друзей).

/** Шифр-заглушка: безопасного хранилища нет. */
function plainCipher() {
  return { available: () => false, encrypt: (s) => Buffer.from(s, 'utf8'), decrypt: (b) => Buffer.from(b).toString('utf8') };
}

function createSecretBox(cipher = plainCipher()) {
  return {
    /** true, если секреты шифруются средствами ОС. */
    get secure() { return !!cipher.available(); },
    seal(obj) {
      const json = JSON.stringify(obj);
      return cipher.available() ? 's1:' + cipher.encrypt(json).toString('base64') : 'p1:' + Buffer.from(json, 'utf8').toString('base64');
    },
    /** → объект с секретами или null, если расшифровать не получилось (другой компьютер, другой пользователь Windows). */
    open(sealed) {
      try {
        if (typeof sealed !== 'string') return null;
        const body = Buffer.from(sealed.slice(3), 'base64');
        if (sealed.startsWith('s1:')) return JSON.parse(cipher.decrypt(body));
        if (sealed.startsWith('p1:')) return JSON.parse(body.toString('utf8'));
      } catch { /* ниже вернём null */ }
      return null;
    },
  };
}

module.exports = { createSecretBox, plainCipher };
