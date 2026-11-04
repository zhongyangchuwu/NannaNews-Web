export function manualPublicUrl(raw: string): string | null {
  if (raw !== raw.trim() || /[\x00-\x20\x7f\\]/.test(raw)) return null;
  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    if (!host.includes('.') && !host.startsWith('[')
      || ['localhost', 'local', 'internal'].some((suffix) => host === suffix || host.endsWith(`.${suffix}`))) return null;
    if (host.startsWith('[')) {
      // Public unicast only; mapped IPv4, local, multicast and documentation ranges stay out.
      const ip = host.slice(1, -1);
      if (!/^[23][a-f0-9]{3}:/.test(ip) || /^2001:(?:[01]?[a-f0-9]{1,2}|db8):/.test(ip)
        || /^3fff:/.test(ip)) return null;
    } else if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
      const [a, b, c, d] = host.split('.').map(Number);
      if (a === 0 || a === 10 || a === 127 || a >= 224 || a === 100 && b >= 64 && b <= 127
        || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31
        || a === 192 && (b === 168 || b === 0 && (c === 2 || c === 0 && d !== 9 && d !== 10))
        || a === 198 && (b === 18 || b === 19 || b === 51 && c === 100)
        || a === 203 && b === 0 && c === 113) return null;
    }
    return url.href;
  } catch {
    return null;
  }
}
