/** V1 location metadata reads must use the signed-in user's management rights. */
export function isLocationMetadataRead(
  endpoint: string,
  method = 'GET'
): boolean {
  const path = endpoint.split(/[?#]/)[0] ?? endpoint;
  return (
    method.toUpperCase() === 'GET' &&
    /^\/(?:locations(?:\/\d+)?|companies|company\/\d+)\/?$/.test(path)
  );
}
