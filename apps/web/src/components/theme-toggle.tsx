import { useEffect, useState } from "react";
import { MoonIcon, SunIcon } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

const STORAGE_KEY = "factory.theme";

/**
 * Dark is the default (docs/design.md D9 puts this in the cockpit; the tokens
 * live in `.dark` and `index.html` ships the class). The stored value is the only
 * override, so a first-time visitor gets dark rather than whatever the OS says,
 * and a second visit gets what they last chose.
 */
const readTheme = (): "dark" | "light" => {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored === "dark" || stored === "light") return stored;
  return "dark";
};

export const ThemeToggle = () => {
  const [theme, setTheme] = useState<"dark" | "light">(readTheme);

  // Applied in an effect rather than during render: the class is on <html>,
  // which is outside React's tree, and doing it here avoids a flash of the wrong
  // theme on first paint of the toggled value.
  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    localStorage.setItem(STORAGE_KEY, theme);
  }, [theme]);

  return (
    <Tooltip>
      <TooltipTrigger
        aria-label={theme === "dark" ? "Switch to light" : "Switch to dark"}
        className="grid size-8 place-items-center text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
        onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
      >
        {theme === "dark" ? (
          <MoonIcon className="size-4" strokeWidth={1.75} />
        ) : (
          <SunIcon className="size-4" strokeWidth={1.75} />
        )}
      </TooltipTrigger>
      <TooltipContent side="right">
        {theme === "dark" ? "Light" : "Dark"}
      </TooltipContent>
    </Tooltip>
  );
};
