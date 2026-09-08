# Frontend Rules (for Codex)

> These are fixed rules. Do not change, remove, or reinterpret any rule below. Only implementation details are flexible.

## 1. Stack (locked)

- React
- TypeScript
- Vite
- GSAP (animation)

Do not swap any of these for another framework/library unless the user explicitly asks.

During any backend or database migration, the existing frontend architecture and UI behavior must stay unchanged.

## 2. Frontend Responsibilities

Frontend does:
- UI rendering
- User interaction
- Client-side validation
- Routing/navigation
- Loading and error states
- Calling backend API services
- Presenting authorized data
- UI animations

Frontend does **not**:
- Contain authoritative authorization logic (auth decisions belong to the backend)
- Talk to the database directly

```
Employee Page → Employee Service → Backend API → Controller → Service → Repository → PostgreSQL
```

Never: `React Component → Direct Database Access`

## 3. Architecture

Feature-based folder structure:

```
src/
  components/
  layouts/
  hooks/
  services/
  utils/
  constants/
  theme/
  assets/
  features/
    employees/
    departments/
    teams/
    attendance/
    leave/
    payroll/
    reports/
    projects/
    kpi/
    settings/
```

Rules:
- Business logic stays out of UI components.
- All API calls go through dedicated service modules (not directly inside components).

## 4. Design Standard

Product should feel like a premium, modern SaaS HRM tool. Keep these consistent everywhere:
- Typography, colors, spacing
- Cards, tables, forms, modals, buttons, icons, navigation, charts, animations

Theming:
- Dark, Light, and System themes must all work correctly with GSAP animations and every UI component.
- Never hardcode theme colors inside animation code — always use existing design tokens/CSS variables.

## 5. Animation Rules (GSAP)

GSAP is required for:
- Page entrance animations
- Component, modal, dropdown, sidebar/nav animations
- Cards, tables (where appropriate), dashboard elements
- Hover interactions, micro-interactions
- Page transitions (where appropriate)

Animation feel: smooth, premium, modern, subtle, fast, professional. No excess — animation must never hurt usability or performance.

**Only animate when it serves a UX purpose:**

| Trigger | Response |
|---|---|
| Page load | Subtle entrance |
| Scroll | Section reveal |
| Interaction | Immediate micro-animation |
| Modal | Smooth open/close |
| Navigation | Controlled transition |

Avoid: excessive bounce, long delays, distracting parallax, constant idle motion, animating every table row, heavy effects that slow the dashboard.

### ScrollTrigger

Use for: scroll reveals, section entrances, staggered reveals, dashboard section animations, timeline/progress animations, parallax (where appropriate), scroll-based transitions.

- Don't put ScrollTrigger on every element.
- Must stay performant — no unnecessary layout recalculation or heavy CPU use.
- Avoid too many simultaneous ScrollTrigger instances.

### React + GSAP Implementation

Use this pattern every time:

```
React Component → useLayoutEffect → gsap.context() → GSAP / ScrollTrigger
```

Requirements:
- Use `useLayoutEffect` (not `useEffect`) for GSAP setup.
- Wrap animations in `gsap.context()`.
- Always clean up / revert on unmount (including ScrollTrigger instances).
- Never create animations directly during render.
- Extract repeated animation patterns into reusable hooks.
- Watch for and avoid memory leaks.

### Responsive Animation

- Must work on desktop, tablet, and mobile.
- Use `ScrollTrigger.matchMedia()` or GSAP responsive utilities where needed.
- Never ship a desktop-only animation that breaks mobile layout.

### Accessibility

- Respect `prefers-reduced-motion` — detect it and reduce/disable non-essential animation.
- Animation must never block access to or interaction with content.

### Performance

- Prefer animating `transform` and `opacity`.
- Avoid animating layout-triggering properties (`width`, `height`, `top`, `left`) unless truly required.
- Use GSAP batching/staggering and efficient ScrollTrigger usage.
