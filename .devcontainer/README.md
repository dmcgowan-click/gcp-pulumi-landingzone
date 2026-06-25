# Dev Containers

This folder contains the devcontainer configuration. By default, it uses a pre-built public image containing all the developer tools you would typically need to deploy not only this landing zone, but a variety of applications.

It also has Ollama and OpenCode baked in, giving you the option of running LLMs locally to assist with your development (disclaimer: you will need some decent CPU / GPU specs to run many of these models locally. If lacking, stick to Copilot!)

Compatible with Windows where WSL is installed!

## Runtime Requirements

To leverage this dev container, your development environment must have the following:

* One of the Following OS
  * Ubuntu / Debian / Redhat
  * macOS
  * Windows with WSL enabled (Ideally WSL2)
* Docker
  * Engine (Linux)
  * Desktop (Mac / Windows)
  * Engine within WSL (Alternate option for Windows)
* Visual Studio Code
  * Dev Containers Plugin
    * If docker engine is installed within WSL, ensure `Dev > Containers: <b>Execute in WSL</b>` is enabled

## Instructions for Opening in a Dev Container

Follow these steps the first time you open the repo in a dev container (this assumes the requirements above have been met)

### Windows Users

* Open PowerShell first, then type `wsl`. This should default to Ubuntu and switch to a directory mounted to your host system. All other users, bring up a terminal as normal
* Navigate to a folder you'd like to open in VS Code
* Type `code .` in the terminal. The first time, you'll see VS Code fetching the components needed to run in WSL. This is a one-time setup.

Note: If this command does not work, you may need to restart your terminal or you may not have added VS Code to your path when it was installed.

After a moment, a new VS Code window will appear, and you'll see a notification that VS Code is opening the folder in WSL.

You should then be prompted to open repo in a dev container. Click yes. You will need to wait a while while the image gets built

### Linux / Mac

* Open VS Code
* Open the repo you want to open

You should then be prompted to open repo in a dev container. Click yes. You will need to wait a while while the image gets built
