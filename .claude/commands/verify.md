Run the Electron app verification loop to visually and programmatically confirm your work.

## Steps

1. Run the verify script:
   ```bash
   node .claude/scripts/electron-verify.mjs $ARGUMENTS
   ```

2. View the default screenshot to visually inspect the app:
   ```bash
   view .claude/verify-output/screenshot.png
   ```

3. Check if there are additional named screen captures and view each one:
   ```bash
   ls .claude/verify-output/*.png
   ```

4. Read the assertion results:
   ```bash
   cat .claude/verify-output/results.json
   ```

5. If the accessibility tree was captured, review it for structural issues:
   ```bash
   cat .claude/verify-output/accessibility.json
   ```

6. **Evaluate what you see**:
   - Do the screenshots match what you intended?
   - Are there any visual regressions or layout issues?
   - Did all assertions pass?
   - Is the accessibility tree reasonable?

7. **If issues are found**: diagnose the root cause, fix the code, and re-run this command to verify the fix.

8. **If everything looks good**: report the results to the user with a summary of what was verified.

## Arguments

- Pass `--skip-build` to skip the build step for faster iteration
- Pass `--screen <name>` to verify a specific named screen only
- Pass `--eval "await page.click('#btn')"` to interact with the app before screenshotting
- Pass `--screenshot-only` to skip assertions
