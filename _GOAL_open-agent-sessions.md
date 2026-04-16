Check the requirement in the .matrix-data. MUST use matrix-creation skill. 

THEN pick 1 next task to do. 
Use @verifier and @build to do it. 

a. IF all matrix requirement ARE completed , pick 3 requirement to verify. 
IF there is any oerror THEN fix it ; 

b. IF there is Still requirement are remaining , do it

c. if ALL verification in (a) are completed successfully WITHOUT any bugs. 
THEN check the NEXT sub agents (codex / zed / ....); THEN delegate SUB AGENTS back and forward to verify and search for it exact format / output. 
THEN persist into .matrix-data requirement. 
MUST have the final @verifier to check it. ONLY consider as GOOD when it is APPROVED. Otherwise fix it. 

---

REMEMBER to search remotely on how others people are implementing similarity stuffs (only repository with >100 stars , preferred >1k stars), take their approach as reference and follow them. 

SOLUTIONS MUST have tests by 1 separate @verifier and approved by ANOTHER @verifier. 

You are iteration {{iteration}}
IF you are iteration %10 == 0: 
- MUST deploy the oas to the machine , then test it yourself. 
fix any problem that cause by works in the commit itself. 

---

ALL implementation MUST follow TDD , use tdd-* related skills. 
ALL works must use sub agents back and forward , do not do it yourself. 

MUST update document and .matrix-data to match the current progress. 

WHENEVER 1 @verifier REJECT , must go back to the begining of the working chain. (build -> verifier -> 2 later verifier)

MUST ensure DRY , reuse , DO NOT reinvent the wheel. 
