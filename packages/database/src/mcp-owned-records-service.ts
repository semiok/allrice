/** Platform code binding, intentionally absent until the actual owned service
 * identity and reviewed definition digest are supplied. No env/admin/model
 * setting can enroll an arbitrary connector. Tests substitute their own
 * controlled service at this module boundary. */
export function ownedRecordsServiceIdentity(): {
  endpoint: string;
  toolDigest: string;
} | null {
  return null;
}
