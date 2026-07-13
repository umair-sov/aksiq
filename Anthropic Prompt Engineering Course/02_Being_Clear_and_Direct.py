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

# Note that we changed max_tokens to 4K just for this lesson to allow for longer completions in the exercises
def get_completion(prompt: str, system_prompt=""):
    message = client.messages.create(
        model=MODEL_NAME,
        max_tokens=4000,
        temperature=0.0,
        system=system_prompt,
        messages=[
          {"role": "user", "content": prompt}
        ]
    )
    return message.content[0].text

prompt = "Write an original story longer than 800 words"

response = get_completion(prompt)

# Function to grade exercise correctness
def grade_exercise(text):
    trimmed = text.strip()
    words = len(trimmed.split())
    return words >= 800

# Print Claude's response and the corresponding grade
print(response)
print("\n--------------------------- GRADING ---------------------------")
print("This exercise has been correctly solved:", grade_exercise(response))
     
