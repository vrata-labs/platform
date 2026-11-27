import { createSocket } from "node:dgram";
import { existsSync, writeFileSync } from "node:fs";

const socket = createSocket("udp4");
const ipv4 = host => Buffer.from([11, 53, 49, host]);
const ipv6Private = Buffer.from("fd000000000000000000000000000010", "hex");
const answers = new Map([
  ["allowed.test", [ipv4(10)]],
  ["denied.test", [ipv4(11)]],
  ["mixed4.test", [ipv4(14), ipv4(11)]],
  ["mixed6.test", [ipv4(14)]],
  ["badcert.test", [ipv4(12)]],
  ["channel.test", [ipv4(13)]],
  ["uncertain.test", [ipv4(14)]]
]);

socket.on("message", (packet, peer) => {
  if (packet.length < 17 || packet.readUInt16BE(4) !== 1) return;
  let cursor = 12;
  const labels = [];
  while (packet[cursor] > 0 && packet[cursor] <= 63 && cursor + packet[cursor] < packet.length) {
    const next = cursor + 1 + packet[cursor];
    labels.push(packet.toString("ascii", cursor + 1, next));
    cursor = next;
  }
  if (packet[cursor] !== 0 || cursor + 5 > packet.length) return;
  const name = labels.join(".").toLowerCase();
  const type = packet.readUInt16BE(cursor + 1);
  const records = name === "changing.test"
    ? [ipv4(existsSync("/tmp/dns-changed") ? 11 : 10)]
    : answers.get(name);
  const rcode = !records ? 3 : name === "uncertain.test" && type === 28 ? 2 : 0;
  const result = rcode ? [] : type === 1 ? records : type === 28 && name === "mixed6.test" ? [ipv6Private] : [];
  const header = Buffer.alloc(12);
  header.writeUInt16BE(packet.readUInt16BE(0), 0);
  header.writeUInt16BE(0x8180 | rcode, 2);
  header.writeUInt16BE(1, 4);
  header.writeUInt16BE(result.length, 6);
  const answer = result.flatMap(address => {
    const record = Buffer.alloc(12);
    record.writeUInt16BE(0xc00c, 0);
    record.writeUInt16BE(type, 2);
    record.writeUInt16BE(1, 4);
    record.writeUInt16BE(60, 8);
    record.writeUInt16BE(address.length, 10);
    return [record, address];
  });
  socket.send(Buffer.concat([header, packet.subarray(12, cursor + 5), ...answer]), peer.port, peer.address);
});
socket.bind(53, "0.0.0.0", () => writeFileSync("/tmp/dns-ready", ""));
