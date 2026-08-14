---
name: book-an-appointment
description: Book a customer onto the business's calendar from ChatGPT. Use when someone asks to schedule, book, reschedule, or find a time for a customer, or asks what times are open. Covers finding real open slots, confirming before booking, and the provider-specific outcomes that make a booking look successful when it is not.
---

# Booking a customer onto the calendar

Booking is one of the few things here that reaches a real person's day. The
tools are safe on their own; the ways this goes wrong are all about ORDER and
about believing a result that does not mean what it looks like.

## The sequence

1. **Find real times first.** Call `calendar_find_slots`. Never invent a time
   or offer one from memory. It returns up to three genuinely open slots.
2. **Offer them and wait.** Let the person pick. Do not book on their behalf
   because a time "looks fine".
3. **Book the slot you were given**, passing the `startIso` and `endIso` from
   the slot rather than re-deriving them from the text you displayed.
4. **Read the result back verbatim.** Confirm the day and time from the
   result's `startLocal` field exactly as returned. Do not reformat it from an
   ISO timestamp, because that is where a timezone slips.

## Three results that are not what they look like

**Calendly does not book.** With Calendly connected, a successful call returns
a single-use scheduling link to send the customer, NOT a confirmed booking.
Telling someone they are booked is wrong in that case. Send them the link and
say it still needs their click.

**A failed booking means the slot is gone.** On `calendar_book_failed`, treat
that time as no longer available. Do not retry it. Call `calendar_find_slots`
again and offer a fresh option, because something else took it.

**Already booked is a question, not an error.** On `attendee_already_booked`
the person already has an upcoming appointment. Offer to keep it, move it, or
cancel it. Only set `allowAdditional: true` after they have explicitly said
they want a second appointment on top of the first.

If no calendar is connected the tool says so. That is a setup task for the
owner on the Integrations page, not something to work around.

## When a message goes with it

If you text or email the customer about the appointment, always name the
timezone ("1:00 PM Eastern", never a bare "1:00 PM"), and give their timezone
too when it differs from the business's. A bare clock time is the single most
common cause of a missed appointment here.

Confirm with the user before sending anything to a customer.

## Multiple businesses

If a tool reports that the account can reach more than one business, call
`list_businesses` and pass `business_id` explicitly rather than guessing which
calendar was meant.
