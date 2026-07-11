export async function registerUser(db, userId) {
  await db
    .prepare(
      `INSERT INTO users (line_user_id) VALUES (?)
       ON CONFLICT(line_user_id) DO UPDATE SET
         is_deleted = 0,
         updated_at = CURRENT_TIMESTAMP`,
    )
    .bind(userId)
    .run();
}

export async function softDeleteUser(db, userId) {
  await db
    .prepare(
      "UPDATE users SET is_deleted = 1, updated_at = CURRENT_TIMESTAMP WHERE line_user_id = ?",
    )
    .bind(userId)
    .run();
}
