const colors = [
  { name: "Claw Green", value: "#1BD96A" },
  { name: "Deep Ink", value: "#0D2235" },
  { name: "Signal Teal", value: "#2EC4B6" },
  { name: "Parchment", value: "#F5F0E8" },
  { name: "Spark Orange", value: "#FF6B35" },
  { name: "Soft Stone", value: "#E8E3D8" }
];

export function PalettePreview() {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12 }}>
      {colors.map((color) => (
        <div key={color.name} className="card">
          <div style={{ background: color.value, height: 42, borderRadius: 8 }} />
          <p>{color.name}</p>
          <p>{color.value}</p>
        </div>
      ))}
    </div>
  );
}
