import type { TimelineMonthGroup } from "@/lib/timeline/contracts";
import styles from "./CompanyTimeline.module.css";

interface TimelineDateNavProps {
  groups: TimelineMonthGroup[];
  activeMonth: string | null;
  onNavigate: (month: string) => void;
}

export function TimelineDateNav({ groups, activeMonth, onNavigate }: TimelineDateNavProps) {
  if (!groups.length) return null;
  const activeYear = activeMonth?.slice(0, 4) ?? String(groups[0]?.year ?? "");

  return (
    <nav className={styles.dateNav} aria-label="Timeline dates">
      {groups.map((group) => (
        <div className={styles.dateNavYear} key={group.year}>
          <button
            type="button"
            className={styles.yearButton}
            aria-current={String(group.year) === activeYear ? "location" : undefined}
            onClick={() => group.months[0] && onNavigate(group.months[0].month)}
          >
            {group.year}
          </button>
          <div className={styles.monthButtons}>
            {group.months.map(({ month, count }) => (
              <button
                type="button"
                key={month}
                aria-current={month === activeMonth ? "location" : undefined}
                aria-label={`${fullMonthLabel(month)}, ${count} ${count === 1 ? "event" : "events"}`}
                onClick={() => onNavigate(month)}
              >
                <span>{shortMonthLabel(month)}</span>
                <small>{count}</small>
              </button>
            ))}
          </div>
        </div>
      ))}
    </nav>
  );
}

function shortMonthLabel(month: string): string {
  return formatMonth(month, "short");
}

function fullMonthLabel(month: string): string {
  return formatMonth(month, "long");
}

function formatMonth(month: string, style: "short" | "long"): string {
  const [year, monthNumber] = month.split("-").map(Number);
  if (!year || !monthNumber) return month;
  return new Intl.DateTimeFormat("en-US", { month: style, timeZone: "UTC" }).format(
    new Date(Date.UTC(year, monthNumber - 1, 1)),
  );
}
