---
name: react-effects
description: Guidelines for when to use (and avoid) useEffect in React components
---

# React Effects Guidelines

**Primary reference:** https://react.dev/learn/you-might-not-need-an-effect

## Quick Decision Tree

Before adding `useEffect`, ask:

1. **Can I calculate this during render?** → Derive it, don't store + sync
2. **Is this resetting state when a prop changes?** → Use `key` prop instead
3. **Is this triggered by a user event?** → Put it in the event handler
4. **Am I syncing with an external system?** → Effect is appropriate

## Legitimate Effect Uses

- DOM manipulation (focus, scroll, measure)
- External widget lifecycle (terminal, charts, non-React libraries)
- Browser API subscriptions (ResizeObserver, IntersectionObserver)
- Data fetching on mount/prop change
- Global event listeners

## Common Anti-Patterns

```tsx
// ❌ Derived state stored separately
const [fullName, setFullName] = useState('');
useEffect(() => setFullName(first + ' ' + last), [first, last]);

// ✅ Calculate during render
const fullName = first + ' ' + last;
```

```tsx
// ❌ Event logic in effect
useEffect(() => { if (isOpen) doSomething(); }, [isOpen]);

// ✅ In the handler
const handleOpen = () => { setIsOpen(true); doSomething(); };
```

```tsx
// ❌ Reset state on prop change
useEffect(() => { setComment(''); }, [userId]);

// ✅ Use key to reset
<Profile userId={userId} key={userId} />
```

## External Store Subscriptions

For subscribing to external data stores (not DOM APIs), prefer `useSyncExternalStore`:

```tsx
// ❌ Manual subscription in effect
const [isOnline, setIsOnline] = useState(true);
useEffect(() => {
  const update = () => setIsOnline(navigator.onLine);
  window.addEventListener('online', update);
  window.addEventListener('offline', update);
  return () => { /* cleanup */ };
}, []);

// ✅ Built-in hook for external stores
const isOnline = useSyncExternalStore(
  subscribe,
  () => navigator.onLine,  // client
  () => true               // server
);
```

## Data Fetching Cleanup

Always handle race conditions with an `ignore` flag:

```tsx
useEffect(() => {
  let ignore = false;
  fetchData(query).then(result => {
    if (!ignore) setData(result);
  });
  return () => { ignore = true; };
}, [query]);
```

## App Initialization

For once-per-app-load logic (not once-per-mount), use a module-level guard:

```tsx
let didInit = false;

function App() {
  useEffect(() => {
    if (!didInit) {
      didInit = true;
      loadDataFromLocalStorage();
      checkAuthToken();
    }
  }, []);
}
```

Or run during module initialization (before render):

```tsx
if (typeof window !== 'undefined') {
  checkAuthToken();
  loadDataFromLocalStorage();
}
```
