# Trial Email Sequence

5-email automated sequence to convert trial users to paid subscribers.

## Files

- `email-templates.js` — All 5 email HTML templates with `getEmailTemplate(day, customerData)` export
- `trial-email-sequence.js` — Daily runner script that reads customer list and sends emails
- `../../data/trial-sequence-config.json` — Customer data and sequence config

## Email Schedule

| Day | Subject | Goal |
|-----|---------|------|
| 1 | "Your OpenClaw agent is ready" | Welcome + setup guide |
| 3 | "Have you tried heartbeats yet?" | Feature education |
| 7 | "How's your AI assistant doing?" | Check-in + use cases |
| 10 | "4 days left in your trial" | Urgency + upgrade CTA |
| 14 | "Last chance — trial ends today" | Final conversion push |

## Setup

### 1. Install Resend

```bash
npm install resend
```

Or use raw fetch (already in the script, no dependency needed).

Set environment variables:
```
RESEND_API_KEY=re_your_key_here
EMAIL_FROM=MrDelegate <noreply@mrdelegate.ai>
```

### 2. Add customers to config

When a customer signs up (Stripe `checkout.session.completed` webhook), add them to `data/trial-sequence-config.json`:

```json
{
  "email": "customer@example.com",
  "firstName": "Jane",
  "trialStartDate": "2026-03-24T10:00:00Z",
  "plan": "Pro",
  "upgradePrice": 49,
  "sentEmails": []
}
```

### 3. Run daily via cron

```bash
# Add to crontab (runs at 9am UTC daily)
0 9 * * * cd /root/mrdelegate/platform && node --input-type=module src/emails/trial-email-sequence.js >> /var/log/mrdelegate-emails.log 2>&1
```

Dry run (preview without sending):
```bash
node --input-type=module src/emails/trial-email-sequence.js --dry-run
```

### 4. Integration with Stripe webhook

In your webhook handler for `checkout.session.completed`:
```js
import { readFile, writeFile } from 'fs/promises';

async function addTrialCustomer(email, firstName, plan) {
  const config = JSON.parse(await readFile('./data/trial-sequence-config.json', 'utf-8'));
  config.customers.push({
    email,
    firstName,
    trialStartDate: new Date().toISOString(),
    plan,
    upgradePrice: { Starter: 29, Pro: 49, Business: 99, Enterprise: 199 }[plan] || 29,
    sentEmails: [],
  });
  await writeFile('./data/trial-sequence-config.json', JSON.stringify(config, null, 2));
}
```

## Customization

Edit `email-templates.js` to change:
- Colors (`BRAND.color`)
- Copy for any email
- CTA button text and URLs
- Brand links and social handles
