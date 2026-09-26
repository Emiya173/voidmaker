const frame = Buffer.alloc(960);
for (let i = 0; i < frame.length; i += 2) frame.writeInt16LE(8000, i);
let frames = 0;
setInterval(() => { process.stdout.write(frames++ < 10 ? frame : Buffer.alloc(960)); }, 5);
