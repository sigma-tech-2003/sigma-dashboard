export function createEmployeeRepository(database) {
  return Object.freeze({
    async findByUserId(userId) {
      const { rows } = await database.query(`
        SELECT id, user_id, company_id, department_id, team_id, employee_number, employment_status
        FROM employees
        WHERE user_id = $1
      `, [userId]);
      return rows[0] || null;
    },
  });
}
