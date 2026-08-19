# Tool and internet foundation

Shiva will eventually use controlled tools for current information and external capabilities. The intended resolution flow is:

```text
User asks something
        |
        v
Can it be answered safely from memory or general knowledge?
        |
        v
If current information is required, is a dedicated tool available?
   YES -> use the dedicated tool
   NO  -> use internet search or browser fallback
```

If information may have changed and Shiva has no current source, Shiva must not guess. Internet access, browsing, and tool execution are deliberately not implemented in V0.1.
