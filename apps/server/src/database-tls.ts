import { readFileSync } from 'node:fs';
import { X509Certificate } from 'node:crypto';
import { checkServerIdentity, type ConnectionOptions } from 'node:tls';

export class DatabaseTlsConfigurationError extends Error {
  readonly code = 'DATABASE_TLS_CONFIGURATION';
}

const sslUrlKeys = new Set(['ssl', 'sslmode', 'sslcert', 'sslkey', 'sslrootcert', 'uselibpqcompat']);

/** Validate before pg parses the URL: its SSL query parameters can read files and override TLS. */
export function databaseConnectionOptions(config: {
  DATABASE_URL: string;
  DATABASE_SSL: boolean;
  DATABASE_SSL_CA_FILE: string;
}): { connectionString: string; ssl: false | ConnectionOptions } {
  let url: URL;
  try {
    url = new URL(config.DATABASE_URL);
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || /%(?![0-9a-f]{2})/i.test(url.href)) throw new Error();
  } catch {
    throw new DatabaseTlsConfigurationError('DATABASE_URL must be a valid PostgreSQL URL');
  }
  for (const key of url.searchParams.keys()) {
    if (sslUrlKeys.has(key.toLowerCase())) {
      throw new DatabaseTlsConfigurationError('Remove SSL parameters from DATABASE_URL; use DATABASE_SSL and DATABASE_SSL_CA_FILE');
    }
  }
  if (!config.DATABASE_SSL) {
    if (config.DATABASE_SSL_CA_FILE) throw new DatabaseTlsConfigurationError('DATABASE_SSL_CA_FILE requires DATABASE_SSL=true');
    // Explicit false also prevents PGSSLMODE from silently enabling TLS.
    return { connectionString: url.href, ssl: false };
  }
  let host: string;
  try { host = (url.searchParams.getAll('host').at(-1) || decodeURIComponent(url.hostname)).replace(/^\[|\]$/g, ''); }
  catch { throw new DatabaseTlsConfigurationError('DATABASE_URL contains an invalid host'); }
  if (!host || host.startsWith('/')) throw new DatabaseTlsConfigurationError('DATABASE_SSL requires a TCP hostname or IP address');
  const ssl: ConnectionOptions = {
    rejectUnauthorized: true,
    // pg omits SNI for IP addresses; verify the actual DB host even in that case.
    checkServerIdentity: (_servername, cert) => checkServerIdentity(host, cert),
  };
  if (config.DATABASE_SSL_CA_FILE) {
    let ca: string;
    try { ca = readFileSync(config.DATABASE_SSL_CA_FILE, 'utf8'); }
    catch { throw new DatabaseTlsConfigurationError('DATABASE_SSL_CA_FILE cannot be read; check the runtime mount and file permissions'); }
    try {
      const certificates = ca.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g);
      if (!certificates?.length || ca.replace(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g, '').trim()) throw new Error();
      for (const certificate of certificates) new X509Certificate(certificate);
    } catch { throw new DatabaseTlsConfigurationError('DATABASE_SSL_CA_FILE must contain a valid PEM certificate bundle'); }
    ssl.ca = ca;
  }
  return { connectionString: url.href, ssl };
}
