import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { setTheme, useTheme } from "@/lib/theme";
import { MoonIcon, SunIcon } from "lucide-react";

/**
 * Dark is the default (docs/design.md D9 puts this in the cockpit; the tokens
 * live in `.dark` and `index.html` ships the class). The stored value is the only
 * override, so a first-time visitor gets dark rather than whatever the OS says,
 * and a second visit gets what they last chose.
 */
export const ThemeToggle = () => {
  const theme = useTheme();

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
