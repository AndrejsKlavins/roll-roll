import { networkInterfaces } from 'node:os'

const VIRTUAL = /vethernet|virtualbox|vmware|hyper-v|wsl|docker|loopback|tailscale|zerotier/i

/** LAN IPv4 addresses, most likely home/venue Wi-Fi first. */
export function lanAddresses(): string[] {
  const found: { name: string; address: string }[] = []
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal) found.push({ name, address: a.address })
    }
  }
  const score = (x: { name: string; address: string }) =>
    (VIRTUAL.test(x.name) ? 10 : 0) +
    (/wi-?fi|wlan|wireless/i.test(x.name) ? 0 : 1) +
    (/^192\.168\./.test(x.address) ? 0 : 2)
  return found.sort((a, b) => score(a) - score(b)).map((x) => x.address)
}
