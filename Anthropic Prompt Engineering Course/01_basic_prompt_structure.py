# pip install anthropic python-dotenv

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

system_prompt = "Speak as if you're a 3 year old"

prompt = "Who is the greatest football(soccer) player of all time"

# Get Claude's response
response = get_completion(prompt, system_prompt)

def grade_excercise(text):
  return bool(re.search(r"giggles", text) or re.search(r"soo", text))

print(response)
print("\n--------------------------- GRADING ---------------------------")
print("This exercise has been correctly solved:", grade_excercise(response))