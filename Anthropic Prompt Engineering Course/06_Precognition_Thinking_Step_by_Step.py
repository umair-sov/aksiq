# pip install anthropic

# Import python's built-in regular expression library
import os
import re
import anthropic
from dotenv import load_dotenv

# Loads ANTHROPIC_API_KEY from a .env file in this directory
load_dotenv()

API_KEY = os.environ.get("ANTHROPIC_API_KEY")
MODEL_NAME = "claude-sonnet-4-5"

client = anthropic.Anthropic(api_key=API_KEY)

def get_completion(prompt: str, system_prompt="", prefill=""):
    message = client.messages.create(
        model=MODEL_NAME,
        max_tokens=2000,
        temperature=0.0,
        system=system_prompt,
        messages=[
          {"role": "user", "content": prompt},
          {"role": "assistant", "content": prefill}
        ]
    )
    return message.content[0].text

# Prompt template with a placeholder for the variable content
PROMPT = """Please classify this email into exactly one of the following categories:
(A) Pre-sale question
(B) Broken or defective item
(C) Billing question
(D) Other (please explain)

First, think through which category fits and why. Then give your final answer as just the letter (A, B, C, or D) wrapped in <answer></answer> tags. For example: <answer>B</answer>

Here is the email: {email}"""
# Prefill for Claude's response, if any
PREFILL = ""

# Variable content stored as a list
EMAILS = [
    "Hi -- My Mixmaster4000 is producing a strange noise when I operate it. It also smells a bit smoky and plasticky, like burning electronics.  I need a replacement.", # (B) Broken or defective item
    "Can I use my Mixmaster 4000 to mix paint, or is it only meant for mixing food?", # (A) Pre-sale question OR (D) Other (please explain)
    "I HAVE BEEN WAITING 4 MONTHS FOR MY MONTHLY CHARGES TO END AFTER CANCELLING!!  WTF IS GOING ON???", # (C) Billing question
    "How did I get here I am not good with computer.  Halp." # (D) Other (please explain)
]

# Correct categorizations stored as a list of lists to accommodate the possibility of multiple correct categorizations per email
ANSWERS = [
    ["B"],
    ["A","D"],
    ["C"],
    ["D"]
]

# Dictionary of string values for each category to be used for regex grading
REGEX_CATEGORIES = {
    "A": "A",
    "B": "B",
    "C": "C",
    "D": "D"
}

# Iterate through list of emails
for i,email in enumerate(EMAILS):
    
    # Substitute the email text into the email placeholder variable
    formatted_prompt = PROMPT.format(email=email)
   
    # Get Claude's response
    response = get_completion(formatted_prompt, prefill=PREFILL)

    # Grade Claude's response
    grade = any([bool(re.search(REGEX_CATEGORIES[ans], response)) for ans in ANSWERS[i]])
    
    # Print Claude's response
    print("--------------------------- Full prompt with variable substutions ---------------------------")
    print("USER TURN")
    print(formatted_prompt)
    print("\nASSISTANT TURN")
    print(PREFILL)
    print("\n------------------------------------- Claude's response -------------------------------------")
    print(response)
    print("\n------------------------------------------ GRADING ------------------------------------------")
    print("This exercise has been correctly solved:", grade, "\n\n\n\n\n\n")