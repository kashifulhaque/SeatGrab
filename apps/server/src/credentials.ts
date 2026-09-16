/**
 * Room codes and seat credentials.
 *
 * These are two different secrets and the difference is the point. A room code is
 * shareable: it is posted in a group chat so people can find the table, and anyone
 * holding it can read the lobby and claim a seat nobody has taken. A seat credential is
 * issued once, to the one client that claimed that seat, and it is the only thing that
 * authorizes a command for that seat. Section 14.1 states the consequence directly: a
 * room code alone must not grant control of an occupied seat, so a claim on an occupied
 * seat is refused and no second credential for it is ever minted.
 *
 * Only hashes are stored. A seat credential is 32 bytes from the system generator, so
 * there is nothing to guess and no password-stretching work factor to choose: a single
 * SHA-256 is the right hash for a high-entropy token, and it is fast enough to do on
 * every request. A slow KDF here would only be a denial-of-service surface. That
 * reasoning does not transfer to a human-chosen secret; if one is ever introduced, it
 * needs a real KDF instead.
 */
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

/**
 * The room-code alphabet, Crockford base32 without the ambiguous letters.
 *
 * A room code is read aloud and typed by hand, so I, L, O, U, 0 and 1 are left out
 * rather than dealt with by a lenient parser that would also accept nonsense.
 */
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';
export const ROOM_CODE_LENGTH = 8;

/** Length of a seat credential in bytes, before base64url encoding. */
export const CREDENTIAL_BYTES = 32;

/** A room code as this server mints it. */
export function generateRoomCode(): string {
  let code = '';
  for (let index = 0; index < ROOM_CODE_LENGTH; index += 1) {
    code += ROOM_CODE_ALPHABET[randomInt(ROOM_CODE_ALPHABET.length)];
  }
  return code;
}

/**
 * Fold a typed room code into the stored form.
 *
 * People type a room code from a chat message, so case and stray spaces are forgiven.
 * Nothing else is: a code carrying a character outside the alphabet is not repaired into
 * a different room.
 */
export function normalizeRoomCode(value: string): string | null {
  const folded = value.trim().toUpperCase().replaceAll(/[\s-]/gu, '');
  if (folded.length !== ROOM_CODE_LENGTH) return null;
  for (const character of folded) {
    if (!ROOM_CODE_ALPHABET.includes(character)) return null;
  }
  return folded;
}

/** A fresh seat credential. This value is returned once and never stored. */
export function generateCredential(): string {
  return randomBytes(CREDENTIAL_BYTES).toString('base64url');
}

/** The stored form of a credential. */
export function hashCredential(credential: string): string {
  return createHash('sha256').update(credential, 'utf8').digest('hex');
}

/**
 * Whether a presented credential matches a stored hash.
 *
 * The comparison is over the two hashes, which are the same length, so it runs in time
 * that does not depend on how much of the credential was right.
 */
export function credentialMatches(presented: string, storedHash: string): boolean {
  const candidate = Buffer.from(hashCredential(presented), 'hex');
  let stored: Buffer;
  try {
    stored = Buffer.from(storedHash, 'hex');
  } catch {
    return false;
  }
  if (candidate.length !== stored.length) return false;
  return timingSafeEqual(candidate, stored);
}

/** A match identifier. Unlike the room code it is never typed, so it is simply random. */
export function generateMatchId(): string {
  return `m-${randomBytes(12).toString('base64url')}`;
}

/** A random seed for `createGame`, from the system generator. */
export function generateSeed(): number {
  return randomBytes(4).readUInt32BE(0);
}

/**
 * The credential a request presented, or `null`.
 *
 * Only the `Authorization: Bearer` form is read. A credential in a query string would be
 * written to every access log and proxy trace it passes, which section 14.2 rules out
 * for a stored secret.
 */
export function readBearer(header: string | undefined): string | null {
  if (header === undefined) return null;
  const match = /^Bearer[ ]+(?<token>[A-Za-z0-9._~+/=-]+)$/u.exec(header.trim());
  return match?.groups?.['token'] ?? null;
}
