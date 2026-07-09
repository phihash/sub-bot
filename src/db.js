export async function registerUser(db, userId) {
  await db
    .prepare(
      "INSERT INTO users (line_user_id) VALUES (?) ON CONFLICT(line_user_id) DO NOTHING",
    )
    .bind(userId)
    .run();
}
