import Foundation
import FoundationModels

struct Request: Decodable {
    var instructions: String
    var input: String
}

@Generable
struct RoomRead {
    @Guide(description: "What seat A is doing, up to six words")
    var situationA: String
    @Guide(description: "What seat B is doing, up to six words")
    var situationB: String
    @Guide(description: "Draft to send from seat A, or an empty string")
    var draftA: String
    @Guide(description: "Confidence in draft A", .range(0.0 ... 1.0))
    var confidenceA: Double
    @Guide(description: "Draft to send from seat B, or an empty string")
    var draftB: String
    @Guide(description: "Confidence in draft B", .range(0.0 ... 1.0))
    var confidenceB: Double
    @Guide(description: "Pitch, Party, Meeting or an empty string")
    var suggestedPreset: String
}

guard SystemLanguageModel.default.isAvailable else { exit(2) }
let request = try JSONDecoder().decode(Request.self, from: FileHandle.standardInput.readDataToEndOfFile())
let session = LanguageModelSession(instructions: request.instructions)
let result = try await session.respond(to: request.input, generating: RoomRead.self, options: .init(temperature: 0)).content
let output: [String: Any] = [
    "situationA": result.situationA,
    "situationB": result.situationB,
    "draftA": result.draftA,
    "confidenceA": result.confidenceA,
    "draftB": result.draftB,
    "confidenceB": result.confidenceB,
    "suggestedPreset": result.suggestedPreset,
]
FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: output))
