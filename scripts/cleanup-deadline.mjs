export async function cleanupWithDeadline(cleanup, emit, timeoutMs = 15000) {
  const timer = setTimeout(() => {
    emit({ stage: 'cleanup_deadline', failed: true, timeoutMs });
    process.exit(1);
  }, timeoutMs);
  try { await cleanup(); }
  catch { emit({ stage: 'cleanup', failed: true }); process.exitCode = 1; }
  finally { clearTimeout(timer); }
}
