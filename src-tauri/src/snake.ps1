$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Speech
$installed = [System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers()
$info = $installed | Where-Object { $_.Culture.TwoLetterISOLanguageName -eq "de" } | Select-Object -First 1
if (!$info) { $info = $installed | Where-Object { $_.Culture.TwoLetterISOLanguageName -eq "en" } | Select-Object -First 1 }
if (!$info) { exit 1 }
$engine = New-Object System.Speech.Recognition.SpeechRecognitionEngine($info)
$words = if ($info.Culture.TwoLetterISOLanguageName -eq "de") { "hoch","runter","links","rechts" } else { "up","down","left","right" }
$choices = New-Object System.Speech.Recognition.Choices
$choices.Add([string[]]$words)
$grammar = New-Object System.Speech.Recognition.GrammarBuilder
$grammar.Culture = $info.Culture
$grammar.Append($choices)
$engine.LoadGrammar((New-Object System.Speech.Recognition.Grammar($grammar)))
$engine.SetInputToDefaultAudioDevice()
[Console]::WriteLine($info.Culture.TwoLetterISOLanguageName)
while (Get-Process -Id $env:SPECHY_PARENT -ErrorAction SilentlyContinue) {
    $result = $engine.Recognize([TimeSpan]::FromSeconds(1))
    if ($result -and $result.Confidence -ge 0.45) { [Console]::WriteLine($result.Text) }
}
