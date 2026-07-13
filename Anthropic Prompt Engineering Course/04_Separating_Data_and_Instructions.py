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

# Variable content
TOPIC = "pigs"

# Prompt template with a placeholder for the variable content
PROMPT = f"Give me a Haiku about {TOPIC}."

# Get Claude's response
response = get_completion(PROMPT)

# Function to grade exercise correctness
def grade_exercise(text):
    return bool(re.search("pigs", text.lower()) and re.search("haiku", text.lower()))

# Print Claude's response
print("--------------------------- Full prompt with variable substutions ---------------------------")
print(PROMPT)
print("\n------------------------------------- Claude's response -------------------------------------")
print(response)
print("\n------------------------------------------ GRADING ------------------------------------------")
print("This exercise has been correctly solved:", grade_exercise(response))
