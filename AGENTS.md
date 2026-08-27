# AGENTS.md

# Sigma HRM - AI Development Guide

> This document is the single source of truth for every AI assistant (Claude, ChatGPT, Codex, Gemini, Copilot, etc.) working on this project. Every change must follow these rules.

---

# Project Vision

Build a modern, enterprise-grade Human Resource Management (HRM) system that is scalable, maintainable, secure, responsive, and production-ready.

The goal is not just to build features but to build a long-term software architecture that can easily support future business requirements.

---

# Core Principles

Always prefer:

- Scalability
- Maintainability
- Reusability
- Performance
- Security
- Clean Architecture
- Consistency

Never build temporary or quick-fix solutions.

---

# Tech Stack

Frontend

- React
- Vite
- Custom hash-based navigation (current implementation)

Backend

- Firebase Authentication
- Cloud Firestore

Animation

- GSAP

Charts

- Recharts

Icons

- Lucide React

---

# Project Goals

The application should feel like a premium SaaS HRM product.

Every module should look and behave consistently.

The codebase should remain clean even after adding many future modules.

---

# User Roles

## Admin

Full system access.

Can manage employees, departments, teams, projects, KPI reviews, attendance,
leave, payroll, reports, settings, permissions, and audit logs.

Can assign Admin, HR, Manager, Team Lead, and Employee roles.

---

## HR

Company-wide operational access.

Can create, edit, activate, deactivate, and delete employee records.

Can assign Manager, Team Lead, and Employee roles, but cannot assign Admin or
HR roles.

Can review attendance, approve or reject leave, view and process payroll,
review project KPI scores, and view company-wide reports.

Can view departments, but only Admin can add, edit, or delete departments.

Cannot modify system settings, permissions, or audit logs.

---

## Manager

Scope limited to assigned department.

Can only access department data.

Can create Employee and Team Lead records inside the assigned department.

Can edit Employees and Team Leads inside the assigned department and can
promote an Employee to Team Lead.

Cannot manage Admin, HR, Managers, another department, payroll, or system
settings.

Can approve or reject department leave requests, review department attendance,
set project KPI scores, and view department reports and analytics.

---

## Team Lead

Scope limited to assigned team.

Can only access team members whose `teamLeadId` matches the logged-in Team Lead.

Can create Employee records for the assigned team. Their department and
`teamLeadId` must be enforced from the authenticated Team Lead, never trusted
from form input.

Can manage assigned team projects and set their KPI scores.

Can approve or reject/cancel leave requests only for employees assigned to the
Team Lead through `teamLeadId`.

Cannot access payroll, department management, or system settings.

---

## Employee

Can only access personal data.

Can view assigned projects, KPI results, leave, attendance, profile, and
processed payslips.

Can apply for leave but cannot set KPI scores, manage employees, approve leave,
or access management reports.

---

# Authentication and Role Selection

The login screen must provide five role selections:

- Admin
- HR
- Manager
- Team Lead
- Employee

Selecting a role does not grant that role. After Firebase Authentication,
compare the selected role with the authenticated user's role stored in the
employee record. If they do not match, deny access and sign the user out.

New employees who need portal access must receive a Firebase Authentication
account and a linked employee record. Never store plaintext passwords in
Firestore.

---

# Theme Requirements

The application must support Dark, Light, and System themes.

Theme selection must apply consistently to pages, charts, tables, forms, and
modals, and must persist across refreshes.

Use design tokens or CSS variables. Do not duplicate theme colors inside page
components.

---

# Projects and KPI Reviews

KPI is a review score for an assigned project or task, not a general employee
rating.

Only Admin, HR, Manager, and Team Lead can set a project KPI score, subject to
their data scope. Employees can only view their results.

KPI scores use a 1 to 10 scale:

- 1-3: Poor
- 4-5: Needs Improvement
- 6-7: Good
- 8-9: Very Good
- 10: Excellent

A KPI review should support the project, assigned employee or team, score,
review comment, reviewer identity, reviewer role, and review date.

Manager reviews are department-scoped. Team Lead reviews are team-scoped.
Users must never score themselves unless a future requirement explicitly
allows self-review.

---

# Data Hierarchy

Company

↓

Departments

↓

Teams

↓

Employees

Every query must respect this hierarchy.

---

# Permission Rules

Never protect features by hiding buttons only.

Permissions must be enforced in:

- UI
- Routing
- Firestore queries
- CRUD operations
- Business logic

Security always comes first.

Role checks and scope rules must have one centralized source of truth. Avoid
broad shortcuts such as treating every non-Employee role as an Admin.

---

# Firestore Rules

Components must never communicate directly with Firestore.

Always use Services.

Example

Employee Page

↓

Employee Service

↓

Firestore

Never

Employee Page

↓

Firestore

---

# Architecture Rules

Use feature-based architecture.

Keep business logic outside UI.

Keep components small.

Keep folders organized.

Every module should follow the same structure.

Example

features/

employees/

departments/

attendance/

leave/

payroll/

reports/

settings/

---

# Folder Guidelines

Use dedicated folders for

- components
- layouts
- hooks
- services
- utils
- constants
- features
- assets
- theme

Avoid dumping files into one folder.

---

# Component Rules

Create reusable components.

Examples

- Button
- Input
- Select
- Modal
- Table
- Card
- Badge
- Avatar
- PageHeader
- EmptyState
- Loading
- Skeleton
- SearchBar
- FilterPanel

If a component is repeated more than once, make it reusable.

---

# UI Design Principles

Modern

Minimal

Professional

Clean

Consistent

Never create outdated admin dashboards.

---

# Design System

Use one consistent design system.

Consistent

- Colors
- Typography
- Shadows
- Border Radius
- Spacing
- Icons
- Buttons
- Forms
- Tables

Avoid inconsistent styling.

---

# Spacing

Use consistent spacing throughout the application.

Avoid random margins and padding.

---

# Typography

Maintain consistent typography.

Use proper hierarchy.

Heading

Subheading

Body

Caption

---

# Dashboard

Dashboard should feel premium.

Use

- Stat Cards
- Charts
- Progress
- Activity
- Quick Actions
- Clean Layout

Avoid clutter.

---

# Tables

Tables should support

- Search
- Sorting
- Pagination
- Filters
- Status Badges
- Responsive Layout

---

# Forms

Every form should have

Validation

Loading State

Disabled State

Success Message

Error Message

Reusable Inputs

---

# Modals

Every modal should have

Smooth animation

Keyboard support

Proper close behavior

Consistent spacing

---

# Animations

Use GSAP only.

Animations should be

Fast

Professional

Subtle

Never overuse animations.

---

# Performance

Always optimize.

Prefer

Lazy Loading

Memoization

Code Splitting

Reusable Hooks

Efficient Firestore Queries

Avoid unnecessary renders.

---

# Code Style

Write readable code.

Avoid large components.

Prefer descriptive names.

Avoid deeply nested logic.

Avoid duplicated code.

Single Responsibility Principle.

---

# Naming Convention

Components

PascalCase

Hooks

useSomething

Functions

camelCase

Constants

UPPER_CASE only when appropriate.

Files should have meaningful names.

---

# Comments

Write comments only when necessary.

Code should explain itself.

Avoid unnecessary comments.

---

# Error Handling

Every async operation should handle

Loading

Success

Error

Empty State

---

# Security

Never trust frontend validation.

Always secure

Authentication

Authorization

Firestore Queries

Permissions

---

# Existing Functionality

Do not break existing functionality.

Every refactor must preserve behavior.

Architecture may improve.

Behavior must remain consistent.

---

# Refactoring Rules

Refactor only when it improves

Readability

Scalability

Maintainability

Never refactor for personal preference.

---

# Future Modules

The architecture must support future modules without major changes.

Future modules include

- Recruitment
- Assets
- Performance Reviews
- Task Management
- Documents
- Notifications
- Calendar
- Chat
- Shift Management
- Biometric Attendance
- Employee Portal
- Company Policies
- Training
- Expenses

---

# AI Instructions

Before making changes

Understand the current architecture.

Prefer improving existing code.

Do not rewrite working modules unnecessarily.

Keep changes focused.

Do not modify unrelated files.

If multiple improvements are needed, complete them one at a time.

Always preserve existing functionality.

Work in small, single-purpose steps. Do not implement the next roadmap item
unless the current request explicitly asks for it.

At the end of every coding task, report changed files and run the relevant
build and lint commands. Fix only errors caused by the current task.

---

# What AI Must Avoid

Do not duplicate code.

Do not hardcode values.

Do not mix business logic with UI.

Do not create oversized components.

Do not introduce breaking changes.

Do not rename files without reason.

Do not change APIs unless necessary.

Do not reduce security.

Do not remove existing features.

---

# Definition of Done

A task is complete only if

- Existing functionality still works.
- Code is clean.
- Code is reusable.
- Code is scalable.
- UI remains consistent.
- Permissions remain secure.
- No duplicated logic exists.
- No unnecessary complexity is introduced.
- The production build succeeds.
- Lint is run and any pre-existing errors are clearly separated from errors
  caused by the current task.
- Changed files and verification results are reported.

---

# Ultimate Goal

Build an enterprise-grade HRM platform that is secure, scalable, maintainable, reusable, modern, responsive, and ready for future business growth without requiring major architectural changes.
