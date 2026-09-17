// Self-contained bookmarklet variant of the Linear script (no storage, default durations).
import { calendarTemplateUrl, DEFAULT_SETTINGS, nextHalfHour, openInNewTab } from './shared.ts';
import { estimateMinutes, issueFromPath, issueTitle } from './linear.ts';

const issue = issueFromPath(location.pathname);
if (!issue) {
  alert('Not on a Linear issue page.');
} else {
  openInNewTab(calendarTemplateUrl({
    title: `${issue.id} ${issueTitle(issue, document.title)}`,
    details: `Linear: ${issue.id}\nhttps://linear.app${location.pathname}`,
    start: nextHalfHour(),
    minutes: estimateMinutes(DEFAULT_SETTINGS),
  }));
}
