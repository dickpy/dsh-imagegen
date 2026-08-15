/** CSS Modules type shim (the bundle inlines the compiled class map). */
declare module '*.module.css' {
  const classes: Record<string, string>
  export default classes
}
