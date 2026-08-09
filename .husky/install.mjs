// Guarded husky install (the pattern from husky's own docs): `prepare` runs
// on EVERY npm ci, including the Docker images' `npm ci --omit=dev`, where
// husky isn't installed — a bare `husky` there exits 127 and kills the
// build. No hooks in an image is correct: images never commit.
try {
  const { default: husky } = await import('husky');

  console.log(husky());
} catch {
  process.exit(0);
}
