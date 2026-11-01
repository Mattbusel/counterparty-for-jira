---
name: counterparty-due-diligence
description: Screen vendors, suppliers and partners for sanctions, healthcare exclusions, ownership and distress using the Counterparty MCP tools on an Atlassian site, and record the result on the Jira work item.
---

# Counterparty due diligence

Use this skill when someone asks whether a company or person is safe to onboard, pay or partner with, or asks about the vendors on a Jira site.

## Tools (from the Counterparty MCP server)

Endpoint: `https://mcp.atlassian.com/forge/d86d1b88-c157-40ff-926b-288eeec0bb41` (a site admin must enable the tools first under Atlassian Administration > Apps > Sites > your site > Connected apps).

- `screen-counterparty` (counterpartyName): read-only screen against OFAC sanctions, HHS-OIG exclusions, GLEIF entity and parent records, SEC filings, USAspending contracts, FDA recalls and CFPB complaints. Returns verdict, reasons, data versions and evidence links.
- `screen-issue-counterparty` (issueKey, counterpartyName optional): screens the vendor on a work item, stores the result (searchable in JQL), sets the verdict label and posts the receipt comment.
- `list-counterparties` (verdict optional: CLEAR, REVIEW, BLOCK): everything screened on the site.
- `get-counterparty-receipt` (issueKey): the stored check and its history.

## Procedure

1. If the user gives a work item, call `screen-issue-counterparty`; otherwise call `screen-counterparty` with the exact legal name they gave.
2. Report the verdict first: CLEAR (proceed), REVIEW (a person must look first) or BLOCK (do not proceed).
3. List at most five reasons, each with its evidence link and the data version of its source.
4. For REVIEW caused by a possible name match, tell the reviewer what to compare: address, country, registration number, date of birth.
5. For BLOCK on a sanctions match, say the payment or onboarding should stop and the compliance owner should be told. Never suggest a workaround.
6. End with the receipt id.

Never state a sanctions or exclusion status from memory; only from a tool result.
