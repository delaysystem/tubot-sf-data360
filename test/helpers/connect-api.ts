/** Package coverage only. Live verification never imports these responses. */
export function connectApiCoverageResponse(input: string): Response | undefined {
  const path = new URL(String(input)).pathname;
  if (path.endsWith('/ssot/data-spaces')) return Response.json({ dataSpaces: [{ name: 'default' }] });
  if (path.endsWith('/ssot/identity-resolutions')) return Response.json({ identityResolutions: [] });
  if (path.endsWith('/ssot/data-lake-objects')) return Response.json({ dataLakeObjects: [] });
  if (path.endsWith('/ssot/data-model-objects')) return Response.json({ dataModelObject: [] });
  if (path.endsWith('/ssot/data-graphs/metadata')) return Response.json({ dataGraphMetadata: [] });
  if (path.endsWith('/ssot/calculated-insights')) return Response.json({ collection: { items: [] } });
}
