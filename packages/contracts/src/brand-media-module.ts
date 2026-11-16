/** Static import only. MET-253 takes over this descriptor and the SAME binding
 * store; this is not a runtime registry or a declaration of future handlers. */
export const brandMediaModule = {
  id: 'allrice.brand-media',
  displayName: '品牌自媒体',
  contractVersion: 1,
  contentVersion: '0.1.0',
  digest:
    'sha256:1f366168ecf5fa83834694ca2b72808ea6a43008c11cbdc2b592cfd7603be8c9',
  requires: [
    'identity.employeeScope',
    'database.transaction',
    'requests.idempotency',
    'audit.record',
    'references.readSelection',
    'deliverables.readExactVersion',
    'images.assertExistingOperation',
  ],
  // P2 has no callable views/tools/Skill/resources. Adding them is a NEW exact
  // release, requiring explicit enablement; never mutate this installed digest.
  views: [],
  tools: [],
  skills: [],
  resources: [],
  enablement: {
    kind: 'human-self-service-instance',
    preinstalled: false,
    permissions: 'current-principal',
    binding: 'exact-version-digest-revision',
  },
  data: {
    tables: ['allrice_brand_media_topics', 'allrice_brand_media_articles'],
    migrations: ['0245_brand_media_contract.sql'],
    runner: 'database.migrations',
    bindings: 'allrice_employee_module_bindings',
  },
  contracts: ['brand-media', 'employee-modules'],
} as const;
export const brandMediaRelease = {
  moduleId: brandMediaModule.id,
  contractVersion: brandMediaModule.contractVersion,
  contentVersion: brandMediaModule.contentVersion,
  digest: brandMediaModule.digest,
} as const;
