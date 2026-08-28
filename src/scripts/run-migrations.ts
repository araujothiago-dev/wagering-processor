import { AppDataSource } from '../config/data-source';

/**
 * One-shot migration runner (AD-10): docker-compose runs this to completion in the `migrate`
 * service before `api` is allowed to accept traffic. Safe to run with zero pending migrations
 * (this story does not add any table migration yet) — it just initializes, runs whatever is
 * pending (nothing, today), and exits cleanly.
 */
async function main(): Promise<void> {
  try {
    await AppDataSource.initialize();
    const executed = await AppDataSource.runMigrations();
    console.log(`[migrate] applied ${executed.length} migration(s).`);
  } finally {
    // A partially-failed initialize() may leave AppDataSource uninitialized — destroying it
    // then would throw. Guard so the real error from initialize()/runMigrations() surfaces
    // instead of being masked (edge-case-hunter finding, Story 1.1 review).
    if (AppDataSource.isInitialized) {
      await AppDataSource.destroy();
    }
  }
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((error: unknown) => {
    console.error('[migrate] failed:', error);
    process.exit(1);
  });
