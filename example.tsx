const MyComponent = () => {
  const [count, setCount] = useState(0);
  useEffect(() => {
    console.log("count", count);
  }, [count]);

  return (
    <div>
      <motion.ul animate={{ rotate: 360 }} />
      <Heart />
      <Car />
      <h1>Count: {count}</h1>
      <button onClick={() => setCount(count + 1)}>Increment</button>
    </div>
  );
};

export { MyComponent };
