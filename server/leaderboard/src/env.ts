export interface Env {
  DB: D1Database;
  AVATARS: R2Bucket;
  /** Secret. Guards /v1/admin/*. Unset = admin API disabled. */
  ADMIN_TOKEN?: string;
  /** Optional secret salt for hashed IP rate-limit keys. */
  IP_HASH_SALT?: string;
  ALLOWED_ORIGINS?: string;
  AUTO_HIDE_AVATAR_REPORTS?: string;
  INACTIVE_DELETE_DAYS?: string;
}
