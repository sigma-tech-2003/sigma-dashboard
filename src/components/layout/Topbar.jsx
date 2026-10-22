import { useRef } from "react";
import { Menu, Monitor, Moon, Sun } from "lucide-react";
import { useSlidingIndicator } from "../../hooks/motion/useSlidingIndicator";
import { useApp } from "../../app/useApp";
import Avatar from "../avatar/Avatar";
import DensityToggle from "../density-toggle/DensityToggle";

const THEMES = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "system", label: "System", icon: Monitor },
];

const Breadcrumbs = ({ items }) => {
  if (!items?.length) return null;

  return (
    <nav className="breadcrumbs" aria-label="Breadcrumb">
      {items.map((item, index) => (
        <span
          key={item.label}
          className="breadcrumbs__item"
          aria-current={index === items.length - 1 ? "page" : undefined}
        >
          {index > 0 && <span className="breadcrumbs__separator" aria-hidden="true">/</span>}
          {item.label}
        </span>
      ))}
    </nav>
  );
};

// Light, dark or follow the system: a segmented control where there is room, one button that cycles on a phone.
const ThemeControl = ({ value, onChange }) => {
  const current = THEMES.find((theme) => theme.value === value) || THEMES[1];
  const next = THEMES[(THEMES.indexOf(current) + 1) % THEMES.length];
  const CurrentIcon = current.icon;
  const segmentedRef = useRef(null);
  useSlidingIndicator(segmentedRef, value, "x");

  return (
    <>
      <div ref={segmentedRef} className="theme-segmented" role="radiogroup" aria-label="Theme">
        <span className="theme-segmented__indicator" data-indicator aria-hidden="true" />
        {THEMES.map(({ value: option, label, icon: Icon }) => (
          <button
            key={option}
            type="button"
            role="radio"
            aria-checked={option === value}
            data-active={option === value ? "true" : undefined}
            aria-label={label}
            title={label}
            className="theme-segmented__option"
            onClick={() => onChange(option)}
          >
            <Icon size={14} aria-hidden="true" />
          </button>
        ))}
      </div>
      <button
        type="button"
        className="topbar-icon-button theme-cycle"
        aria-label={`Theme: ${current.label}. Switch to ${next.label}`}
        title={`Theme: ${current.label}`}
        onClick={() => onChange(next.value)}
      >
        <CurrentIcon size={16} aria-hidden="true" />
      </button>
    </>
  );
};

// The page's own heading names the page, so the bar carries only where you are (the breadcrumb), not the title again.
const Topbar = ({ user, pageTitle, breadcrumbs, onMenuToggle }) => {
  const { themePreference, setThemePreference } = useApp();
  const trail = breadcrumbs?.length ? breadcrumbs : [{ label: pageTitle }];

  return (
    <header className="topbar">
      <button
        type="button"
        onClick={onMenuToggle}
        className="topbar-icon-button"
        aria-label="Toggle navigation"
      >
        <Menu size={18} aria-hidden="true" />
      </button>

      <div className="topbar-page">
        <Breadcrumbs items={trail} />
      </div>

      <div className="topbar-tools">
        <DensityToggle />
        <ThemeControl value={themePreference} onChange={setThemePreference} />
      </div>

      <div className="topbar-profile">
        <Avatar emp={user} size={24} />
        <span>{user.name.split(" ")[0]}</span>
      </div>
    </header>
  );
};

export default Topbar;
