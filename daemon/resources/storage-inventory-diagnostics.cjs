// Storage work that is pending, as storage report warnings.
async function discoverDiagnostics(profile, discovery) {
  if (require('./session-database.cjs').cleanupRequest(profile, 'temporary-chat') !== undefined) discovery.warnings.push('Temporary folder cleanup for deleted sessions is pending');
}

module.exports = { discoverDiagnostics };
