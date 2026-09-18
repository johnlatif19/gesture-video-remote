// test-ws.js — شغله مؤقتًا من غير ما تحفظه
const WebSocket = require('ws');

const tv = new WebSocket('ws://localhost:3000/ws');
let code;

tv.on('open', () => console.log('TV connected'));

tv.on('message', (raw) => {
  const msg = JSON.parse(raw);
  console.log('TV received:', msg);

  if (msg.type === 'ROOM_CREATED') {
    code = msg.code;

    // Spawn a phone
    const phone = new WebSocket('ws://localhost:3000/ws');

    phone.on('open', () =>
      phone.send(JSON.stringify({ type: 'JOIN_ROOM', code, role: 'phone' }))
    );

    phone.on('message', (raw) => {
      const m = JSON.parse(raw);
      console.log('Phone received:', m);

      if (m.type === 'ROOM_JOINED') {
        // Send a command
        phone.send(JSON.stringify({ type: 'COMMAND', command: 'PLAY' }));

        setTimeout(() => phone.close(), 500);
      }
    });
  }

  if (msg.type === 'PHONE_CONNECTED') console.log('✅ Phone connected to TV');
  if (msg.type === 'COMMAND') console.log('🎮 TV got command:', msg.command);
  if (msg.type === 'PHONE_DISCONNECTED') {
    console.log('📴 Phone disconnected');
    setTimeout(() => { tv.close(); process.exit(0); }, 300);
  }
});