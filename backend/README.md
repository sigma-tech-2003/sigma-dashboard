# Sigma HRM API foundation

This directory is an isolated Node.js and PostgreSQL foundation for the future
Firebase migration. It does not replace Firebase Authentication, Firestore, or
Cloud Functions yet, and the React application does not call this API yet.

## Structure

- `src/routes`, `src/controllers`: HTTP transport only.
- `src/services`: future business logic and scope enforcement.
- `src/repositories`: future PostgreSQL data access.
- `src/middleware`: shared error handling, request identity, and authentication boundaries.
- `src/db`: connection pool and migrations.
- `scripts`: explicit migration and schema validation commands.

## Local setup

1. Copy `.env.example` to `.env` and provide a local PostgreSQL `DATABASE_URL`.
2. Install dependencies with `npm install` from this directory.
3. Validate migration files with `npm run db:validate`.
4. Apply migrations only to the intended database with `npm run db:migrate`.
5. Start the API with `npm run dev`.

`db:migrate` is the only command that connects to PostgreSQL. It is intentionally
not run by the API, tests, or validation scripts. Existing Firebase data must not
be imported until a separate, approved migration step.

## Initial access model

`users.role` stores the existing application roles: `admin`, `hr`, `manager`,
`tl`, and `employee`. Employee scope is anchored by the employee's company,
department, and optional team. Future authorization services must enforce:

- Admin and HR: company-wide access.
- Manager: records in their department.
- Team Lead: records in their assigned team.
- Employee: their own record.

The database schema enforces tenant, department, team, user, and employee
relationships. Role assignment, login, token issuance, and employee CRUD remain
out of scope for this foundation.
