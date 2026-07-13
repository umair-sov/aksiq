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

def get_completion(prompt: str, system_prompt=""):
    message = client.messages.create(
        model=MODEL_NAME,
        max_tokens=2000,
        temperature=0.0,
        system=system_prompt,
        messages=[
          {"role": "user", "content": prompt}
        ]
    )
    return message.content[0].text

system_prompt = "You are a high school math professor and are one of the most qualified in yout field. You are currently doing a PHD in Mathematics."
prompt = """Is this equation solved correctly below?

2x - 3 = 9
2x = 6
x = 3"""

# Get Claude's response
response = get_completion(prompt, system_prompt)

# Function to grade exercise correctness
def grade_exercise(text):
    if "incorrect" in text or "not correct" in text.lower():
        return True
    else:
        return False

# Print Claude's response and the corresponding grade
print(response)
print("\n--------------------------- GRADING ---------------------------")
print("This exercise has been correctly solved:", grade_exercise(response))