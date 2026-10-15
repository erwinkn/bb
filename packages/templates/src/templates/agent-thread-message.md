---
kind: prompt
title: Agent Thread Message
summary: Wraps a bb CLI message from one agent thread to another.
intent: Tell the receiving agent which thread sent the message without prompting an unnecessary reply.
editingNotes: Keep only sender identity, and the send time when one turn carries several messages, in the prefix; reply instructions cause agents to acknowledge messages that do not need responses. Extra fields go after a semicolon inside the brackets, where the timeline's envelope parser expects them.
variables:
  senderThreadId: The thread ID that sent the message.
  sentAt?: When the sender sent the message, in ISO 8601 UTC. Set only when one turn carries several queued messages.
  messageText: The original message text sent by the agent.
---
[bb message from thread:{{senderThreadId}}{{#if sentAt}}; sent {{sentAt}}{{/if}}]

{{messageText}}
